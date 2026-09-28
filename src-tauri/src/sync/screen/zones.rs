// From a screen image to one color per light — the "ambilight" part.
//
// 1. The frame (BGRX, as X11 delivers it) is reduced to a coarse grid of
//    average colors (GRID_COLS × GRID_ROWS), sampling a few pixels per cell —
//    cheap even at 4K, and the rest works on a few hundred cells.
// 2. Each light looks at the part of the screen matching its place in the
//    sync area: x (-1 left … 1 right) → horizontal, height z (-1 floor …
//    1 ceiling) → vertical. Cells are weighted by a Gaussian around that
//    point, so neighbours blend smoothly instead of switching at hard edges.
// 3. Near-black cells (letterbox bars, dark UI chrome) count for little,
//    so a film's bars don't pull every light toward black.
// 4. Saturation is boosted a little: averages of real images are greyish,
//    and lights show washed-out colors poorly.
//
// Pure — tested with synthetic frames.

use crate::sync::effects::Rgb;
use crate::sync::entertainment::api::AreaChannel;

pub const GRID_COLS: usize = 32;
pub const GRID_ROWS: usize = 18;
/// Samples per cell edge (4 × 4 = 16 pixels per cell).
const SAMPLES: usize = 4;
/// Spread of a light's view, in screen fractions.
const SIGMA_X: f32 = 0.18;
const SIGMA_Y: f32 = 0.35;
/// Linear luminance below which a cell counts as "black bar".
const DARK: f32 = 0.01;
const DARK_WEIGHT: f32 = 0.05;
const SATURATION: f32 = 1.3;

/// Coarse screen colors, linear RGB, row-major.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub cells: Vec<Rgb>,
}

/// Averages a BGRX frame (4 bytes per pixel, `stride` bytes per row) into the grid.
pub fn grid_from_bgrx(frame: &[u8], width: usize, height: usize, stride: usize) -> Grid {
    let mut cells = Vec::with_capacity(GRID_COLS * GRID_ROWS);
    for row in 0..GRID_ROWS {
        for col in 0..GRID_COLS {
            let mut sum = [0.0f32; 3];
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    // Sample centers spread evenly inside the cell.
                    let x = ((col * SAMPLES + sx) * 2 + 1) * width / (GRID_COLS * SAMPLES * 2);
                    let y = ((row * SAMPLES + sy) * 2 + 1) * height / (GRID_ROWS * SAMPLES * 2);
                    let i = y * stride + x * 4;
                    if let Some(px) = frame.get(i..i + 3) {
                        sum[0] += srgb_to_linear(px[2]);
                        sum[1] += srgb_to_linear(px[1]);
                        sum[2] += srgb_to_linear(px[0]);
                    }
                }
            }
            let n = (SAMPLES * SAMPLES) as f32;
            cells.push([sum[0] / n, sum[1] / n, sum[2] / n]);
        }
    }
    Grid { cells }
}

/// The screen point a light watches: (0,0) top-left … (1,1) bottom-right.
pub fn watch_point(channel: &AreaChannel) -> (f32, f32) {
    let u = ((channel.position.x as f32 + 1.0) / 2.0).clamp(0.0, 1.0);
    let v = (1.0 - (channel.position.z as f32 + 1.0) / 2.0).clamp(0.0, 1.0);
    (u, v)
}

pub fn zone_colors(grid: &Grid, channels: &[AreaChannel]) -> Vec<Rgb> {
    channels
        .iter()
        .map(|channel| {
            let (u, v) = watch_point(channel);
            let mut sum = [0.0f32; 3];
            let mut total = 0.0f32;
            for (i, cell) in grid.cells.iter().enumerate() {
                let cu = ((i % GRID_COLS) as f32 + 0.5) / GRID_COLS as f32;
                let cv = ((i / GRID_COLS) as f32 + 0.5) / GRID_ROWS as f32;
                let dx = (cu - u) / SIGMA_X;
                let dy = (cv - v) / SIGMA_Y;
                let mut w = (-(dx * dx + dy * dy) / 2.0).exp();
                if luminance(*cell) < DARK {
                    w *= DARK_WEIGHT;
                }
                for c in 0..3 {
                    sum[c] += cell[c] * w;
                }
                total += w;
            }
            let avg = if total > 0.0 { sum.map(|s| s / total) } else { [0.0; 3] };
            saturate(avg, SATURATION)
        })
        .collect()
}

fn luminance(c: Rgb) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn saturate(c: Rgb, amount: f32) -> Rgb {
    let grey = luminance(c);
    c.map(|v| (grey + (v - grey) * amount).clamp(0.0, 1.0))
}

fn srgb_to_linear(v: u8) -> f32 {
    let v = v as f32 / 255.0;
    if v > 0.04045 { ((v + 0.055) / 1.055).powf(2.4) } else { v / 12.92 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::entertainment::api::Position;

    const W: usize = 320;
    const H: usize = 180;

    /// A BGRX frame painted by `paint(x, y) -> (r, g, b)`.
    fn frame(paint: impl Fn(usize, usize) -> (u8, u8, u8)) -> Vec<u8> {
        let mut data = vec![0u8; W * H * 4];
        for y in 0..H {
            for x in 0..W {
                let (r, g, b) = paint(x, y);
                let i = (y * W + x) * 4;
                data[i..i + 4].copy_from_slice(&[b, g, r, 0]);
            }
        }
        data
    }

    fn light(x: f64, z: f64) -> AreaChannel {
        AreaChannel { channel_id: 0, position: Position { x, y: 1.0, z } }
    }

    fn dominant(c: Rgb) -> usize {
        (0..3).max_by(|&a, &b| c[a].total_cmp(&c[b])).unwrap()
    }

    #[test]
    fn left_light_takes_the_left_color() {
        let grid = grid_from_bgrx(&frame(|x, _| if x < W / 2 { (255, 0, 0) } else { (0, 0, 255) }), W, H, W * 4);
        let colors = zone_colors(&grid, &[light(-0.8, 0.0), light(0.8, 0.0)]);
        assert_eq!(dominant(colors[0]), 0, "left → red: {colors:?}");
        assert_eq!(dominant(colors[1]), 2, "right → blue: {colors:?}");
    }

    #[test]
    fn height_picks_top_or_bottom() {
        let grid = grid_from_bgrx(&frame(|_, y| if y < H / 2 { (0, 255, 0) } else { (255, 0, 0) }), W, H, W * 4);
        let colors = zone_colors(&grid, &[light(0.0, 0.9), light(0.0, -0.9)]);
        assert_eq!(dominant(colors[0]), 1, "high light → top (green): {colors:?}");
        assert_eq!(dominant(colors[1]), 0, "low light → bottom (red): {colors:?}");
    }

    #[test]
    fn letterbox_bars_do_not_darken_the_picture() {
        // Black bars top and bottom (a film), orange picture in the middle.
        let bars = |_: usize, y: usize| if y < H / 5 || y > H * 4 / 5 { (0, 0, 0) } else { (255, 140, 0) };
        let grid = grid_from_bgrx(&frame(bars), W, H, W * 4);
        let color = zone_colors(&grid, &[light(0.0, 0.9)])[0];
        assert!(color[0] > 0.7, "the picture wins over the bars: {color:?}");
    }

    #[test]
    fn black_screen_is_dark() {
        let grid = grid_from_bgrx(&frame(|_, _| (0, 0, 0)), W, H, W * 4);
        assert_eq!(zone_colors(&grid, &[light(0.0, 0.0)])[0], [0.0, 0.0, 0.0]);
    }

    #[test]
    fn stride_padding_is_respected() {
        // Rows padded to a larger stride must read the same as unpadded.
        let tight = frame(|x, _| if x < W / 2 { (255, 0, 0) } else { (0, 255, 0) });
        let stride = W * 4 + 64;
        let mut padded = vec![0u8; stride * H];
        for y in 0..H {
            padded[y * stride..y * stride + W * 4].copy_from_slice(&tight[y * W * 4..(y + 1) * W * 4]);
        }
        assert_eq!(grid_from_bgrx(&tight, W, H, W * 4), grid_from_bgrx(&padded, W, H, stride));
    }

    #[test]
    fn watch_point_maps_area_coordinates() {
        assert_eq!(watch_point(&light(-1.0, 1.0)), (0.0, 0.0));
        assert_eq!(watch_point(&light(1.0, -1.0)), (1.0, 1.0));
        assert_eq!(watch_point(&light(0.0, 0.0)), (0.5, 0.5));
    }
}
