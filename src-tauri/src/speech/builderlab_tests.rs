use super::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const OFFER: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
const COMMUNITY: &str = "wss://relay.example.com";
type Seen = Arc<StdMutex<Vec<(String, Value)>>>;

/// One connection per response; `None` accepts and never answers. Returns the
/// URL and each request's lowercased head and JSON body.
async fn server(responses: Vec<Option<(u16, String)>>) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/{ROUTE}", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let log = seen.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 8192];
            let (head, body) = loop {
                let n = socket.read(&mut buf).await.unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length || n == 0 {
                        break (
                            text[..end].to_ascii_lowercase(),
                            request[end + 4..].to_vec(),
                        );
                    }
                }
            };
            log.lock()
                .unwrap()
                .push((head, serde_json::from_slice(&body).unwrap_or(Value::Null)));
            match response {
                Some((status, body)) => {
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(reply.as_bytes()).await.unwrap();
                }
                None => held.push(socket),
            }
        }
        std::future::pending::<()>().await;
        drop(held);
    });
    (url, seen)
}

fn bearer() -> SignIn {
    SignIn::Bearer(Zeroizing::new("fi-session-do-not-use".into()))
}

fn answer() -> String {
    json!({ "sdp": "v=0\r\nanswer", "call_id": "rtc_1", "model": "gpt-realtime-whisper", "max_seconds": 30 })
        .to_string()
}

#[test]
fn the_endpoint_keeps_the_deployment_path_and_port() {
    assert_eq!(
        endpoint("https://login.example:8443", "/deployment/api/goose/").as_deref(),
        Some("https://login.example:8443/deployment/api/goose/v3/builderlab/transcription/calls")
    );
    assert_eq!(endpoint("", "/api/"), None);
}

#[tokio::test]
async fn sends_the_offer_with_the_sign_in_and_community_and_names_no_model() {
    let (url, seen) = server(vec![Some((200, answer()))]).await;
    let result = connect(
        &url,
        &bearer(),
        OFFER,
        Some(COMMUNITY),
        None,
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        connected(result),
        Connected::Answered {
            sdp: "v=0\r\nanswer".into(),
            max_seconds: Some(30)
        }
    );
    let seen = seen.lock().unwrap();
    let (head, body) = &seen[0];
    assert!(head.contains("authorization: bearer fi-session-do-not-use")); // sadscan:disable np.http.2
    assert!(head.contains("x-buzz-community: relay.example.com"));
    assert_eq!(body, &json!({ "sdp": OFFER, "languages": ["en"] }));
}

#[tokio::test]
async fn a_requested_cap_is_sent_and_the_granted_one_returned() {
    let granted = json!({ "sdp": "v=0\r\nanswer", "call_id": "rtc_1", "model": "gpt-realtime-whisper", "max_seconds": 900 })
        .to_string();
    let (url, seen) = server(vec![Some((200, granted))]).await;
    let result = connect(
        &url,
        &bearer(),
        OFFER,
        Some(COMMUNITY),
        Some(3_600),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        connected(result),
        Connected::Answered {
            sdp: "v=0\r\nanswer".into(),
            max_seconds: Some(900)
        }
    );
    assert_eq!(
        seen.lock().unwrap()[0].1,
        json!({ "sdp": OFFER, "languages": ["en"], "max_seconds": 3_600 })
    );

    // A zero cap is refused here rather than sent.
    assert_eq!(
        connect(
            &url,
            &bearer(),
            OFFER,
            Some(COMMUNITY),
            Some(0),
            Duration::from_secs(5)
        )
        .await
        .err(),
        Some(Refused::Failed(Failure::InvalidRequest))
    );
}

#[tokio::test]
async fn the_development_session_goes_in_its_own_header() {
    let (url, seen) = server(vec![Some((200, answer()))]).await;
    let session = SignIn::Session(Zeroizing::new("public-revision".into()));
    let result = connect(
        &url,
        &session,
        OFFER,
        Some(COMMUNITY),
        None,
        Duration::from_secs(5),
    )
    .await;
    assert!(result.is_ok());
    let head = &seen.lock().unwrap()[0].0;
    assert!(head.contains("x-bb-session-credential: public-revision"));
    assert!(!head.contains("authorization:"));
}

#[tokio::test]
async fn nothing_is_sent_without_a_community_or_a_valid_offer() {
    let (url, seen) = server(vec![]).await;
    let timeout = Duration::from_secs(5);
    for (offer, community) in [
        (OFFER, None),
        (OFFER, Some("not a relay")),
        ("", Some(COMMUNITY)),
    ] {
        assert_eq!(
            connect(&url, &bearer(), offer, community, None, timeout)
                .await
                .err(),
            Some(Refused::Failed(Failure::InvalidRequest))
        );
    }
    let empty = SignIn::Bearer(Zeroizing::new(" ".into()));
    assert_eq!(
        connect(&url, &empty, OFFER, Some(COMMUNITY), None, timeout)
            .await
            .err(),
        Some(Refused::Failed(Failure::MissingCredentials))
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn statuses_map_to_one_failure_and_are_not_retried() {
    let cases = [
        (401, Refused::SessionExpired),
        (302, Refused::Failed(Failure::Unauthorized)),
        (403, Refused::Failed(Failure::Unauthorized)),
        (400, Refused::Failed(Failure::InvalidRequest)),
        (413, Refused::Failed(Failure::InvalidRequest)),
        (429, Refused::Failed(Failure::RateLimited)),
        (502, Refused::Failed(Failure::ServiceError)),
        (503, Refused::Failed(Failure::ServiceError)),
        (200, Refused::Failed(Failure::InvalidResponse)),
    ];
    for (status, refused) in cases {
        let body = if status == 200 {
            "{\"sdp\":\"nope\"}".into()
        } else {
            String::new()
        };
        let (url, seen) = server(vec![Some((status, body)), Some((200, answer()))]).await;
        let result = connect(
            &url,
            &bearer(),
            OFFER,
            Some(COMMUNITY),
            None,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result.err(), Some(refused), "{status}");
        assert_eq!(seen.lock().unwrap().len(), 1, "{status}");
    }
}

#[tokio::test]
async fn a_401_refuses_the_call_without_ending_anything_else() {
    assert_eq!(
        connected(Err(Refused::SessionExpired)),
        Connected::Failed {
            reason: Failure::Unauthorized
        }
    );
}

#[tokio::test]
async fn the_deadline_bounds_the_call() {
    let (url, _) = server(vec![None]).await;
    let result = connect(
        &url,
        &bearer(),
        OFFER,
        Some(COMMUNITY),
        None,
        Duration::from_millis(200),
    )
    .await;
    assert_eq!(result.err(), Some(Refused::Failed(Failure::Timeout)));
}
