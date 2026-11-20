//! Remote CI harness. Production builds have no test CA or caller-selected root.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    path::PathBuf,
};
use studio_mobile_git::{Job, Profile};

#[derive(Deserialize)]
struct Request {
    profile: Profile,
    job: Job,
    password: Option<String>,
}
fn report(message: Value) {
    println!("{message}");
    io::stdout().flush().unwrap();
}
fn main() {
    let base = PathBuf::from(std::env::args_os().nth(1).expect("fixture AppData"));
    let ca = PathBuf::from(std::env::args_os().nth(2).expect("fixture CA"));
    let request: Request = serde_json::from_reader(io::stdin()).unwrap();
    studio_mobile_git::initialize(&base).unwrap();
    unsafe {
        git2::opts::set_ssl_cert_file(ca.as_path()).unwrap();
    }
    match studio_mobile_git::execute(
        &base,
        &request.profile,
        request.job,
        request.password.as_deref().unwrap_or(""),
        &|phase, n, total| {
            report(json!({"progress":{"phase":phase,"loaded":n,"total":total}}));
        },
    ) {
        Ok(value) => report(json!({"value":value})),
        Err(error) => report(json!({"error":error})),
    }
}
