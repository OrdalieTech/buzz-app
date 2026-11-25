//! Builderlab as a hosted speech provider: one POST of the webview's offer to
//! `v3/builderlab/transcription/calls`, which answers it with OpenAI's SDP and
//! meters the call. The request names no model, so the route's default
//! transcribes. It bills the community, so a call without one is not sent.
//! A call may ask for a longer cap than the route's default (30 seconds);
//! the route answers with the cap it granted, which may be less.
use super::{Connected, Failure};
use serde::Deserialize;
use std::time::Duration;
use zeroize::Zeroizing;

const ROUTE: &str = "v3/builderlab/transcription/calls";
const OFFER_LIMIT: usize = 64 * 1024;
const RESPONSE_LIMIT: usize = 64 * 1024;

/// The Builderlab sign-in a call sends.
pub(super) enum SignIn {
    /// The development broker's public session revision.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    Session(Zeroizing<String>),
    /// An FI build's native session, which Builderlab takes as Bearer.
    Bearer(Zeroizing<String>),
}

/// Why Builderlab refused a call.
#[derive(Debug, PartialEq)]
pub(super) enum Refused {
    /// The sign-in itself is no longer valid (401).
    SessionExpired,
    Failed(Failure),
}

#[derive(Debug, Deserialize)]
pub(super) struct Answer {
    sdp: String,
    #[serde(default)]
    max_seconds: Option<u32>,
}

/// The transcription route under the build's Builderlab API, whose path keeps
/// any deployment prefix, as sign-in does.
pub(super) fn endpoint(origin: &str, api_base_path: &str) -> Option<String> {
    Some(origin)
        .filter(|origin| !origin.is_empty())
        .map(|origin| format!("{origin}{api_base_path}{ROUTE}"))
}

#[cfg(debug_assertions)]
pub(super) fn development_endpoint(origin: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(origin).map_err(|_| "Invalid development origin")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || url.port().is_none()
        || url.origin().ascii_serialization() != origin
    {
        return Err("Invalid development origin".into());
    }
    Ok(format!("{origin}/api/builderlab/transcription/calls"))
}

pub(super) fn connected(result: Result<Answer, Refused>) -> Connected {
    match result {
        Ok(answer) => Connected::Answered {
            sdp: answer.sdp,
            max_seconds: answer.max_seconds,
        },
        // A 401 here refuses this call; only the FI caller rechecks the session.
        Err(Refused::SessionExpired) => Connected::Failed {
            reason: Failure::Unauthorized,
        },
        Err(Refused::Failed(reason)) => Connected::Failed { reason },
    }
}

/// One call within `timeout`, never retried.
pub(super) async fn connect(
    endpoint: &str,
    sign_in: &SignIn,
    offer: &str,
    community: Option<&str>,
    max_seconds: Option<u32>,
    timeout: Duration,
) -> Result<Answer, Refused> {
    let failed = |reason| Err(Refused::Failed(reason));
    if offer.trim().is_empty() || offer.len() > OFFER_LIMIT {
        return failed(Failure::InvalidRequest);
    }
    let Some(community) = community.and_then(crate::decisions::community_host) else {
        return failed(Failure::InvalidRequest);
    };
    let secret = match sign_in {
        SignIn::Session(secret) | SignIn::Bearer(secret) => secret,
    };
    if secret.trim().is_empty() {
        return failed(Failure::MissingCredentials);
    }
    let Some(client) = client() else {
        return failed(Failure::ServiceError);
    };
    let mut body = serde_json::json!({ "sdp": offer, "languages": ["en"] });
    if let Some(max_seconds) = max_seconds {
        if max_seconds == 0 {
            return failed(Failure::InvalidRequest);
        }
        body["max_seconds"] = max_seconds.into();
    }
    let body = body.to_string();
    let post = client.post(endpoint);
    #[cfg(debug_assertions)]
    let post = if endpoint.starts_with("http://") {
        match reqwest::Url::parse(endpoint) {
            Ok(url) => post.header("Origin", url.origin().ascii_serialization()),
            Err(_) => return failed(Failure::ServiceError),
        }
    } else {
        post
    };
    let post = match sign_in {
        SignIn::Session(credential) => post.header("x-bb-session-credential", credential.as_str()),
        SignIn::Bearer(token) => post.bearer_auth(token.as_str()),
    };
    let call = async {
        let response = post
            .header("x-buzz-community", community)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| Refused::Failed(Failure::ServiceError))?;
        let status = response.status().as_u16();
        let reason = match status {
            200 | 201 => None,
            401 => return Err(Refused::SessionExpired),
            // A redirect is a sign-in page, never an answer. A 403 refuses
            // transcription, not the sign-in other Builderlab features share.
            300..=399 | 403 => Some(Failure::Unauthorized),
            400 | 413 | 422 => Some(Failure::InvalidRequest),
            429 => Some(Failure::RateLimited),
            _ => Some(Failure::ServiceError),
        };
        if let Some(reason) = reason {
            return Err(Refused::Failed(reason));
        }
        let bytes = read_limited(response).await?;
        let answer = serde_json::from_slice::<Answer>(&bytes)
            .map_err(|_| Refused::Failed(Failure::InvalidResponse))?;
        if !answer.sdp.starts_with("v=0") {
            return Err(Refused::Failed(Failure::InvalidResponse));
        }
        Ok(answer)
    };
    match tokio::time::timeout(timeout, call).await {
        Ok(result) => result,
        Err(_) => failed(Failure::Timeout),
    }
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, Refused> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Refused::Failed(Failure::ServiceError))?
    {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(Refused::Failed(Failure::InvalidResponse));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // A redirect is a sign-in page, never an answer; never follow it.
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()
                .ok()
        })
        .as_ref()
}

#[cfg(test)]
#[path = "builderlab_tests.rs"]
mod tests;
