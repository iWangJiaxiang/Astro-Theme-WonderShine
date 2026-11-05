use urlpattern::{UrlPattern, UrlPatternMatchInput};

// Run the native transport unit/wire tests in the existing remote-CI test target.
#[path = "../src/cnb_account.rs"]
mod cnb_account;

#[test]
fn cnb_command_is_local_main_only_on_desktop_and_mobile() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/cnb-account.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["webviews"], serde_json::json!(["main"]));
    assert!(capability.get("windows").is_none());
    assert!(capability.get("remote").is_none());
    assert!(capability.get("platforms").is_none());
    assert_eq!(capability["permissions"], serde_json::json!(["allow-cnb-account-get"]));
    let permission = include_str!("../permissions/cnb-account.toml");
    assert!(permission.contains("commands.allow = [\"cnb_account_get\"]"));
}

// Validate permission patterns with the same parser as tauri-plugin-http.
// Invalid entries otherwise fail lazily at runtime and disable every HTTP request.
#[test]
fn configured_http_scope_allows_only_https_and_loopback_http() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    let http = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["identifier"] == "http:default")
        .unwrap();
    let patterns: Vec<UrlPattern> = http["allow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let pattern = entry["url"].as_str().unwrap();
            let mut init =
                urlpattern::UrlPatternInit::parse_constructor_string::<regex::Regex>(pattern, None)
                    .unwrap();
            init.pathname = Some("*".into());
            init.search = Some("*".into());
            init.hash = Some("*".into());
            UrlPattern::parse(init, Default::default()).expect(pattern)
        })
        .collect();
    let allowed = |url: &str| {
        patterns.iter().any(|pattern| {
            pattern
                .test(UrlPatternMatchInput::Url(url.parse().unwrap()))
                .unwrap()
        })
    };
    for url in [
        "https://provider.example/v1/chat/completions",
        "https://provider.example:8443/v1/chat/completions",
        "http://localhost:18361/v1/chat/completions",
        "http://127.0.0.1:18361/v1/images/generations",
        "http://[::1]:18361/v1/chat/completions",
    ] {
        assert!(allowed(url), "must allow {url}");
    }
    for url in [
        "http://provider.example/v1",
        "http://192.168.1.1/v1",
        "http://127.0.0.1.evil.example/v1",
        "file:///etc/passwd",
    ] {
        assert!(!allowed(url), "must deny {url}");
    }
}
