//! Narrow, cookie-free native CNB discovery. Never expose an arbitrary HTTP client over IPC.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri_plugin_http::reqwest::{self, header, Client, ClientBuilder, Request, Url};

const API: &str = "https://api.cnb.cool";
const MAX_BODY: usize = 2 * 1024 * 1024;
const INVALID: &str = "Invalid CNB discovery request";
const UNAVAILABLE: &str = "CNB discovery unavailable";
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

struct Slot;
impl Slot {
    fn acquire() -> Result<Self, &'static str> {
        IN_FLIGHT.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 4).then_some(n + 1)
        }).map_err(|_| UNAVAILABLE)?;
        Ok(Self)
    }
}
impl Drop for Slot {
    fn drop(&mut self) { IN_FLIGHT.fetch_sub(1, Ordering::AcqRel); }
}

fn endpoint(resource: &str, page: Option<u32>) -> Result<Url, &'static str> {
    let path = match (resource, page) {
        ("account", None) => "/user".to_owned(),
        ("repos", Some(page @ 1..=1_000_000)) =>
            format!("/user/repos?page_size=100&page={page}&role=Developer&status=active"),
        _ => return Err(INVALID),
    };
    Url::parse(&format!("{API}{path}")).map_err(|_| INVALID)
}

fn client_builder() -> ClientBuilder {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .cookie_store(false)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
}

fn request(client: &Client, resource: &str, page: Option<u32>, token: &str) -> Result<Request, &'static str> {
    let url = endpoint(resource, page)?;
    // RFC 6750 b64token; reject header injection and bound IPC-to-header allocation.
    if token.is_empty() || token.len() > 8192 || !token.bytes().all(|b|
        b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b)) {
        return Err(INVALID);
    }
    let mut authorization = header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| INVALID)?;
    authorization.set_sensitive(true);
    client.get(url)
        .header(header::AUTHORIZATION, authorization)
        .header(header::ACCEPT, "application/vnd.cnb.api+json")
        .header(header::USER_AGENT, "WonderShine-Studio")
        .build().map_err(|_| INVALID)
}

fn diagnostic(name: &str, value: &str) -> bool {
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
    match name {
        "x-trace-id" => (16..=64).contains(&value.len()) && hex(value),
        "traceparent" if value.len() == 55 => {
            let parts: Vec<_> = value.split('-').collect();
            parts.len() == 4 && parts.iter().zip([2, 32, 16, 2]).all(|(s, len)| s.len() == len && hex(s))
        }
        _ => false,
    }
}

async fn send(client: &Client, request: Request) -> Result<serde_json::Value, &'static str> {
    let mut response = client.execute(request).await.map_err(|_| UNAVAILABLE)?;
    let status = response.status();
    let mut headers = Vec::new();
    for name in ["x-trace-id", "traceparent"] {
        if let Some(value) = response.headers().get(name).and_then(|value| value.to_str().ok()) {
            if diagnostic(name, value) { headers.push((name.to_owned(), value.to_owned())); }
        }
    }
    // Errors and redirects need only status/trace metadata, never a potentially secret body.
    let mut body = Vec::new();
    if status.is_success() {
        if response.content_length().is_some_and(|length| length > MAX_BODY as u64) {
            return Ok(serde_json::json!({"status": status.as_u16(), "headers": headers, "body": ""}));
        }
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= MAX_BODY - body.len() => body.extend_from_slice(&chunk),
                Ok(None) => break,
                _ => { body.clear(); break; }
            }
        }
    }
    // Invalid/oversized success bodies become a safe parse-stage error with HTTP metadata.
    let body = String::from_utf8(body).unwrap_or_default();
    Ok(serde_json::json!({"status": status.as_u16(), "headers": headers, "body": body}))
}

#[tauri::command]
pub async fn cnb_account_get(
    webview: tauri::Webview,
    resource: String,
    page: Option<u32>,
    token: String,
) -> Result<serde_json::Value, &'static str> {
    // The application ACL additionally requires a local main-window invocation, on mobile too.
    if webview.label() != "main" { return Err(INVALID); }
    let _slot = Slot::acquire()?;
    let client = client_builder().build().map_err(|_| UNAVAILABLE)?;
    let request = request(&client, &resource, page, &token)?;
    drop(token);
    send(&client, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn destination_and_headers_are_not_caller_controlled() {
        let client = client_builder().build().unwrap();
        let req = request(&client, "repos", Some(2), "fixture-token").unwrap();
        assert_eq!(req.url().as_str(), "https://api.cnb.cool/user/repos?page_size=100&page=2&role=Developer&status=active");
        assert_eq!(req.method(), reqwest::Method::GET);
        assert!(!req.headers().contains_key(header::ORIGIN));
        assert!(!req.headers().contains_key(header::COOKIE));
        assert!(req.headers()[header::AUTHORIZATION].is_sensitive());
        for (resource, page) in [("https://evil.test", None), ("/user", None), ("account", Some(1)), ("repos", None), ("repos", Some(0)), ("repos", Some(1_000_001))] {
            assert!(endpoint(resource, page).is_err());
        }
        for token in ["", "a\r\nOrigin: x", "a b", "é"] {
            assert!(request(&client, "account", None, token).is_err());
        }
        assert!(request(&client, "account", None, &"a".repeat(8193)).is_err());
        assert!(diagnostic("x-trace-id", "0123456789abcdef"));
        assert!(!diagnostic("x-trace-id", "secret-token"));
        assert!(!diagnostic("set-cookie", "0123456789abcdef"));
    }

    // Only test code can replace the destination and disable HTTPS. The actual request builder,
    // client policy and response reader are shared; production IPC has no such switches.
    fn local_response(raw_response: String) -> (serde_json::Value, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/user", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
            }
            let _ = socket.write_all(raw_response.as_bytes());
            String::from_utf8(bytes).unwrap()
        });
        let result = tauri::async_runtime::block_on(async {
            let client = client_builder().https_only(false).no_proxy().build().unwrap();
            let mut req = request(&client, "account", None, "fixture-token").unwrap();
            *req.url_mut() = Url::parse(&url).unwrap();
            send(&client, req).await.unwrap()
        });
        (result, server.join().unwrap())
    }

    #[test]
    fn real_http_omits_origin_and_cookies_and_preserves_safe_metadata() {
        for status in [200, 403, 302] {
            let body = if status == 200 { "{\"username\":\"fixture\"}" } else { "private-response-body" };
            let (response, wire) = local_response(format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:1/must-not-follow\r\nSet-Cookie: secret=fixture\r\nX-Trace-Id: 0123456789abcdef\r\n\r\n{body}", body.len()));
            let wire = wire.to_lowercase();
            assert!(wire.starts_with("get /user http/1.1\r\n"));
            assert!(wire.contains("\r\nauthorization: bearer fixture-token\r\n"));
            assert!(!wire.contains("\r\norigin:"));
            assert!(!wire.contains("\r\ncookie:"));
            assert_eq!(response["status"], status);
            assert_eq!(response["body"], if status == 200 { body } else { "" });
            assert_eq!(response["headers"], serde_json::json!([["x-trace-id", "0123456789abcdef"]]));
        }
    }

    #[test]
    fn oversized_success_is_discarded_without_losing_status() {
        for raw in [
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BODY + 1),
            format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}", "a".repeat(MAX_BODY + 1)),
            "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\nshort".to_owned(),
        ] {
            let (response, _) = local_response(raw);
            assert_eq!(response["status"], 200);
            assert_eq!(response["body"], "");
        }
    }

    #[test]
    fn cancelled_frontend_requests_cannot_create_unbounded_native_work() {
        let slots: Vec<_> = (0..4).map(|_| Slot::acquire().unwrap()).collect();
        assert!(Slot::acquire().is_err());
        drop(slots);
        assert!(Slot::acquire().is_ok());
    }

    #[test]
    fn production_client_rejects_http_and_never_returns_raw_network_errors() {
        tauri::async_runtime::block_on(async {
            let client = client_builder().build().unwrap();
            let mut req = request(&client, "account", None, "fixture-token").unwrap();
            // Test-only mutation: HTTPS-only rejects before connecting, without disclosing URL/token.
            *req.url_mut() = Url::parse("http://127.0.0.1:1/fixture-private-url").unwrap();
            assert_eq!(send(&client, req).await.unwrap_err(), UNAVAILABLE);
        });
    }
}
