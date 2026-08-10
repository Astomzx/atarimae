// Without this, a release build on Windows opens a console window behind the
// application. The attribute is cfg'd so `cargo test` on this crate still has
// a terminal to print to.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    atarimae_desktop_lib::run();
}
