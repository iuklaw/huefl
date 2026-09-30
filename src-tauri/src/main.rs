// Bez konsoli w buildzie release na Windowsie; na Linuksie bez znaczenia.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    huefl_lib::run()
}
