//! Native half of the app's speech-to-text service (see
//! `features/speech/service.ts`). The webview owns the microphone, the WebRTC
//! peer connection and the transcript; a speech provider plugin only answers
//! the SDP offer. A third-party provider answers it in its own code. The
//! bundled Builderlab provider answers it here, so its sign-in never reaches
//! the webview.
//!
//! `speech_connect` posts the offer to `v3/builderlab/transcription/calls` at
//! the Builderlab of the community the call bills, with that community in
//! `x-buzz-community`. An FI build signs in with the community's NIP-FI
//! session (a Builderlab customer's community has its own server, as remote
//! agents use); live development uses the broker's sign-in. Builderlab
//! answers with OpenAI's SDP, and audio then streams peer to peer.
use crate::federated_identity::FederatedIdentity;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

mod builderlab;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Provider {
    Builderlab,
}

/// Why a hosted call did not connect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    /// No sign-in, or the build has no Builderlab.
    MissingCredentials,
    /// The provider refused this account or community.
    Unauthorized,
    /// The provider refused the offer or the community.
    InvalidRequest,
    /// The community has used its calls for now.
    RateLimited,
    Timeout,
    ServiceError,
    InvalidResponse,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum Connected {
    Answered {
        /// The provider's SDP answer to the offer.
        sdp: String,
        /// The provider hangs up this long after answering.
        #[serde(skip_serializing_if = "Option::is_none")]
        max_seconds: Option<u32>,
    },
    Failed {
        reason: Failure,
    },
}

const TIMEOUT: Duration = Duration::from_secs(20);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    /// The webview's WebRTC SDP offer.
    offer: String,
    /// The Buzz community (its relay URL) the call bills.
    #[serde(default)]
    community: Option<String>,
    /// How long the caller waits, at most 20 seconds.
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// The call's cap the caller asks for, in seconds. Without one the
    /// provider uses its default, as voice commands do.
    #[serde(default)]
    max_seconds: Option<u32>,
}

/// The development broker's public session, as decisions take it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DevelopmentSession {
    origin: String,
    revision: String,
}

/// The FI session `revision`, if it is still the current one, the work it
/// owns, and the transcription route under the identity origin's API.
fn federated_sign_in(
    fi: &FederatedIdentity,
    revision: &str,
) -> Option<(CancellationToken, Option<String>, builderlab::SignIn)> {
    let cancel = fi.cancellation_for(revision).ok()?;
    fi.with_session(|token, current, config| {
        (current == revision).then(|| {
            (
                cancel,
                builderlab::endpoint(&config.identity_origin, &config.api_base_path),
                builderlab::SignIn::Bearer(token.clone()),
            )
        })
    })
    .flatten()
}

/// The sign-in server of the community (its relay URL) a call bills: a
/// Builderlab customer's community has its own, and any other the build's.
pub(crate) fn community_server(
    fi: &FederatedIdentity,
    community: &str,
) -> Option<FederatedIdentity> {
    let relay = crate::federated_identity::config::canonical_relay(community).ok()?;
    fi.server_for(&relay).ok()
}

/// Answers Builderlab's WebRTC offer. An FI build names its native
/// session by `federated` revision, and the token stays here; only that
/// session may answer, so a sign-out or account switch during the call drops
/// it. A Builderlab 401 refuses this call only, and the adapter, asked once in
/// the background, decides whether the session ended. Nothing is retried.
#[tauri::command]
pub(crate) async fn speech_connect(
    fi: tauri::State<'_, FederatedIdentity>,
    provider: Provider,
    request: ConnectRequest,
    broker: Option<DevelopmentSession>,
    federated: Option<String>,
) -> Result<Connected, String> {
    let Provider::Builderlab = provider;
    let timeout = request
        .timeout_ms
        .map(Duration::from_millis)
        .map_or(TIMEOUT, |t| t.clamp(MIN_TIMEOUT, TIMEOUT));
    let missing = Connected::Failed {
        reason: Failure::MissingCredentials,
    };
    if let Some(revision) = federated {
        if broker.is_some() {
            return Err("Invalid federated session".into());
        }
        // The community's own sign-in server answers: a Builderlab
        // customer's community bills, and transcribes, at its server, not
        // the build's.
        let Some(community) = request.community.as_deref() else {
            return Ok(Connected::Failed {
                reason: Failure::InvalidRequest,
            });
        };
        let Some(server) = community_server(&fi, community) else {
            return Ok(Connected::Failed {
                reason: Failure::InvalidRequest,
            });
        };
        let Some((cancel, endpoint, sign_in)) = federated_sign_in(&server, &revision) else {
            return Ok(missing);
        };
        let Some(endpoint) = endpoint else {
            return Ok(missing);
        };
        let connected = tokio::select! {
            biased;
            () = cancel.cancelled() => return Ok(missing),
            connected = builderlab::connect(&endpoint, &sign_in, &request.offer, Some(community), request.max_seconds, timeout) => connected,
        };
        if cancel.is_cancelled() {
            return Ok(missing);
        }
        return Ok(match connected {
            Err(builderlab::Refused::SessionExpired) => {
                tokio::spawn(async move { server.recheck(&revision).await });
                Connected::Failed {
                    reason: Failure::Unauthorized,
                }
            }
            other => builderlab::connected(other),
        });
    }
    if let Some(broker) = broker {
        #[cfg(not(debug_assertions))]
        {
            let _ = (broker.origin, broker.revision);
            return Err("Development sign-in unavailable".into());
        }
        #[cfg(debug_assertions)]
        {
            if broker.revision.is_empty() {
                return Err("Invalid development session".into());
            }
            let endpoint = builderlab::development_endpoint(&broker.origin)?;
            let sign_in = builderlab::SignIn::Session(Zeroizing::new(broker.revision));
            let connected = builderlab::connect(
                &endpoint,
                &sign_in,
                &request.offer,
                request.community.as_deref(),
                request.max_seconds,
                timeout,
            )
            .await;
            return Ok(builderlab::connected(connected));
        }
    }
    // Builderlab answers only an FI or broker sign-in.
    Ok(missing)
}
