//! Internal transport composition plus public command denial, not trusted HTTPS/Wry acceptance.
use super::*;
use crate::host_files::managed_tests::{commands, digest, Fixture};
use std::io::{Read as _, Write as _};

fn server(response: Vec<u8>) -> (reqwest::Url, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let thread = std::thread::spawn(move || {
        let end = std::time::Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < end =>
                {
                    std::thread::yield_now()
                }
                other => panic!("fixture accept failed: {other:?}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 4096];
        let n = socket.read(&mut request).unwrap();
        assert!(request[..n].starts_with(b"GET /bytes HTTP/1.1"));
        assert!(!String::from_utf8_lossy(&request[..n])
            .to_ascii_lowercase()
            .contains("cookie:"));
        let _ = socket.write_all(&response);
    });
    (
        reqwest::Url::parse(&format!("http://{address}/bytes")).unwrap(),
        thread,
    )
}

#[test]
fn actual_non_utf8_get_frame_save_and_existing_native_reader_compose() {
    let _serial = commands();
    let f = Fixture::new(true, true);
    let (url, server) = server(b"HTTP/1.1 418 Unavailable\r\nContent-Length: 4\r\nSet-Cookie: ignored=1\r\nX-Test: bytes\r\nConnection: close\r\n\r\n\x00\x9f\xff\x01".to_vec());
    let (status, headers, bytes) = tauri::async_runtime::block_on(read_bytes(
        reqwest::Client::new()
            .get(url)
            .timeout(Duration::from_secs(5)),
        4,
    ))
    .unwrap();
    server.join().unwrap();
    assert_eq!(status, 418);
    assert_eq!(bytes, [0, 159, 255, 1]);
    assert!(!headers.contains_key("set-cookie"));
    let frame = byte_frame(status, headers, bytes).unwrap();
    let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    let metadata: serde_json::Value = serde_json::from_slice(&frame[4..4 + length]).unwrap();
    assert_eq!(metadata["status"], 418);
    assert_eq!(metadata["headers"]["x-test"], "bytes");
    let bytes = &frame[4 + length..];
    let saved = f.save(bytes, &digest(bytes)).unwrap();
    let result = f
        .ipc(
            "plugin_host_read_file",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"example.bytes", "revision":f.revision, "path":saved["path"]
            })),
            Default::default(),
        )
        .unwrap();
    match result {
        tauri::ipc::InvokeResponseBody::Raw(read) => assert_eq!(read, bytes),
        _ => panic!("expected raw bytes"),
    }
}

#[test]
fn chunked_actual_bytes_are_bounded_and_empty_non_success_is_valid() {
    for (response, cap, expected) in [
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nAB\r\n2\r\nCD\r\n0\r\n\r\n".to_vec(), 3, None),
        (b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec(), 1, Some(0)),
        (b"HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\nConnection: close\r\n\r\nABC".to_vec(), 3, Some(3)),
        (b"HTTP/1.1 200 OK\r\nContent-Length: 99\r\nConnection: close\r\n\r\nABC".to_vec(), 3, None),
    ] {
        let (url, server) = server(response);
        let result = tauri::async_runtime::block_on(read_bytes(reqwest::Client::new().get(url).timeout(Duration::from_secs(5)), cap));
        server.join().unwrap();
        match expected { Some(n) => assert_eq!(result.unwrap().2.len(), n), None => assert!(result.is_err()) }
    }
    assert!(byte_frame(
        200,
        BTreeMap::from([("large".into(), "x".repeat(20 * 1024))]),
        vec![]
    )
    .is_err());
}

#[test]
fn byte_ipc_refuses_headers_http_bad_limits_stale_disabled_and_undeclared_origins() {
    let _serial = commands();
    let f = Fixture::new(true, false);
    let invoke = |request: serde_json::Value, revision: &str| {
        f.ipc(
            "plugin_host_request_bytes",
            tauri::ipc::InvokeBody::Json(serde_json::json!({
                "id":"example.bytes", "revision":revision, "request":request
            })),
            Default::default(),
        )
    };
    for request in [
        serde_json::json!({"url":"http://example.test/","maxBytes":1}),
        serde_json::json!({"url":"https://user:pass@example.test/","maxBytes":1}),
        serde_json::json!({"url":"https://example.test/","maxBytes":0}),
        serde_json::json!({"url":"https://example.test/","maxBytes":MAX_RESPONSE_BYTES+1}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1.5}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1,"timeoutMs":30001}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1,"timeoutMs":0}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1,"headers":{"Cookie":"private"}}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1,"body":"x"}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1,"method":"POST"}),
        serde_json::json!({"url":"https://example.test/","maxBytes":1,"once":{}}),
    ] {
        assert!(invoke(request, &f.revision).is_err());
    }
    let request = serde_json::json!({"url":"https://other.example.test/","maxBytes":1});
    assert!(invoke(request, &f.revision)
        .err()
        .unwrap()
        .contains("not declared"));
    let request = serde_json::json!({"url":"https://example.test/","maxBytes":1});
    assert!(invoke(request.clone(), "stale")
        .err()
        .unwrap()
        .contains("unavailable"));
    f.manager.change("disable", "example.bytes").unwrap();
    assert!(invoke(request, &f.revision)
        .err()
        .unwrap()
        .contains("unavailable"));
    assert!(!f.root().exists());
}

#[test]
fn byte_origin_recheck_observes_revocation_and_queue_respects_request_deadline() {
    // Hold process-wide fixture serialization outside the async task until it completes.
    let _serial = commands();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            use tauri::Manager as _;
            let f = Fixture::new(true, false);
            let url = reqwest::Url::parse("https://example.test/bytes").unwrap();
            byte_origin(f.app.state(), "example.bytes", &f.revision, &url)
                .await
                .unwrap();
            f.manager.change("disable", "example.bytes").unwrap();
            assert!(
                byte_origin(f.app.state(), "example.bytes", &f.revision, &url)
                    .await
                    .is_err()
            );
            let permit = crate::host_files::BYTE_WORK.try_acquire().unwrap();
            let result = plugin_host_request_bytes(
                f.app.state(),
                "example.bytes".into(),
                f.revision.clone(),
                ByteRequest {
                    url: url.to_string(),
                    max_bytes: 1,
                    timeout_ms: Some(1),
                },
            )
            .await;
            assert!(result.err().unwrap().contains("timed out"));
            drop(permit);
        });
}

#[tokio::test]
async fn stalled_chunk_reader_obeys_its_deadline_without_an_application_retry() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nA\r\n")
            .await
            .unwrap();
        started.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), held)
            .await
            .unwrap()
            .unwrap();
        listener
    });
    let request = reqwest::Client::new()
        .get(format!("http://{address}/bytes"))
        .timeout(Duration::from_millis(100));
    let reading = tokio::spawn(read_bytes(request, 4));
    tokio::time::timeout(Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), reading)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    release.send(()).unwrap();
    let listener = server.await.unwrap().into_std().unwrap();
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}
