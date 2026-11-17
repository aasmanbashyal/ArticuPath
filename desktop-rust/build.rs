fn main() {
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        use std::{path::PathBuf, process::Command};

        println!("cargo:rerun-if-changed=rehearse.rc");
        println!("cargo:rerun-if-changed=../public/assets/rehearse.ico");
        let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("rehearse.res");
        let target = std::env::var("TARGET").unwrap();
        let mut rc =
            find_msvc_tools::find(&target, "rc.exe").unwrap_or_else(|| Command::new("rc.exe"));
        let status = rc
            .args(["/nologo", "/fo"])
            .arg(&out)
            .arg("rehearse.rc")
            .status()
            .expect("Could not run the Windows SDK resource compiler");
        assert!(status.success(), "Could not embed the ArticuPath icon");
        println!("cargo:rustc-link-arg={}", out.display());
    }
}
