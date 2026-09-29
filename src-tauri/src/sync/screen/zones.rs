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
// 4. Saturation and brightness are boosted by intensity (ZoneStyle):
//    averages of real images are greyish and dim, and lights show washed-out
//    colors poorly. Higher intensity also narrows each light's view, for more
//    local, contrasting colors.
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

/// How strongly the screen's colors are shown on the lights.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZoneStyle {
    pub saturation: f32,
    /// Brightness multiplier; colors are scaled back when a channel would clip.
    pub gain: f32,
    /// Multiplier of each light's view (SIGMA_X / SIGMA_Y); smaller = more local.
    pub focus: f32,
}

impl ZoneStyle {
    /// Per intensity step, 0 subtle … 3 extreme.
    pub fn for_intensity(intensity: u8) -> Self {
        const STYLES: [ZoneStyle; 4] = [
            ZoneStyle { saturation: 1.15, gain: 1.0, focus: 1.2 },
            ZoneStyle { saturation: 1.35, gain: 1.3, focus: 1.0 },
            ZoneStyle { saturation: 1.7, gain: 1.8, focus: 0.8 },
            ZoneStyle { saturation: 2.1, gain: 2.6, focus: 0.6 },
        ];
        STYLES[usize::from(intensity.min(3))]
    }
}

impl Default for ZoneStyle {
    fn default() -> Self {
        Self::for_intensity(1)
    }
}

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

pub fn zone_colors(grid: &Grid, channels: &[AreaChannel], style: ZoneStyle) -> Vec<Rgb> {
    channels
        .iter()
        .map(|channel| {
            let (u, v) = watch_point(channel);
            let mut sum = [0.0f32; 3];
            let mut total = 0.0f32;
            for (i, cell) in grid.cells.iter().enumerate() {
                let cu = ((i % GRID_COLS) as f32 + 0.5) / GRID_COLS as f32;
                let cv = ((i / GRID_COLS) as f32 + 0.5) / GRID_ROWS as f32;
                let dx = (cu - u) / (SIGMA_X * style.focus);
                let dy = (cv - v) / (SIGMA_Y * style.focus);
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
            amplify(saturate(avg, style.saturation), style.gain)
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

/// Brighter by `gain`, keeping the hue: when a channel would pass 1, the
/// whole color is scaled back instead of clipping toward white.
fn amplify(c: Rgb, gain: f32) -> Rgb {
    let boosted = c.map(|v| v * gain);
    let peak = boosted.iter().cloned().fold(0.0f32, f32::max);
    if peak > 1.0 { boosted.map(|v| v / peak) } else { boosted }
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
        let colors = zone_colors(&grid, &[light(-0.8, 0.0), light(0.8, 0.0)], ZoneStyle::default());
        assert_eq!(dominant(colors[0]), 0, "left → red: {colors:?}");
        assert_eq!(dominant(colors[1]), 2, "right → blue: {colors:?}");
    }

    #[test]
    fn height_picks_top_or_bottom() {
        let grid = grid_from_bgrx(&frame(|_, y| if y < H / 2 { (0, 255, 0) } else { (255, 0, 0) }), W, H, W * 4);
        let colors = zone_colors(&grid, &[light(0.0, 0.9), light(0.0, -0.9)], ZoneStyle::default());
        assert_eq!(dominant(colors[0]), 1, "high light → top (green): {colors:?}");
        assert_eq!(dominant(colors[1]), 0, "low light → bottom (red): {colors:?}");
    }

    #[test]
    fn letterbox_bars_do_not_darken_the_picture() {
        // Black bars top and bottom (a film), orange picture in the middle.
        let bars = |_: usize, y: usize| if y < H / 5 || y > H * 4 / 5 { (0, 0, 0) } else { (255, 140, 0) };
        let grid = grid_from_bgrx(&frame(bars), W, H, W * 4);
        let color = zone_colors(&grid, &[light(0.0, 0.9)], ZoneStyle::default())[0];
        assert!(color[0] > 0.7, "the picture wins over the bars: {color:?}");
    }

    #[test]
    fn black_screen_is_dark() {
        let grid = grid_from_bgrx(&frame(|_, _| (0, 0, 0)), W, H, W * 4);
        assert_eq!(zone_colors(&grid, &[light(0.0, 0.0)], ZoneStyle::default())[0], [0.0, 0.0, 0.0]);
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
    fn gain_keeps_the_hue_and_never_clips() {
        let c = amplify([0.5, 0.25, 0.1], 3.0);
        assert!((c[0] - 1.0).abs() < 1e-6, "{c:?}");
        assert!((c[1] / c[0] - 0.5).abs() < 1e-6 && (c[2] / c[0] - 0.2).abs() < 1e-6, "{c:?}");
        assert_eq!(amplify([0.0; 3], 3.0), [0.0; 3]);
    }

    #[test]
    fn extreme_is_brighter_and_more_saturated_than_subtle() {
        // A dim, greyish orange: what an average of a real picture looks like.
        let grid = grid_from_bgrx(&frame(|_, _| (140, 100, 70)), W, H, W * 4);
        let [subtle, extreme] = [0, 3].map(|i| zone_colors(&grid, &[light(0.0, 0.0)], ZoneStyle::for_intensity(i))[0]);
        let max = |c: Rgb| c.iter().cloned().fold(0.0f32, f32::max);
        let min = |c: Rgb| c.iter().cloned().fold(1.0f32, f32::min);
        assert!(max(extreme) > max(subtle) * 1.5, "{subtle:?} → {extreme:?}");
        assert!(min(extreme) / max(extreme) < min(subtle) / max(subtle), "{subtle:?} → {extreme:?}");
    }

    #[test]
    fn extreme_separates_neighbours_more() {
        let halves = frame(|x, _| if x < W / 2 { (255, 0, 0) } else { (0, 0, 255) });
        let grid = grid_from_bgrx(&halves, W, H, W * 4);
        // How much blue the left light picks up from the right half.
        let bleed = |i| {
            let c = zone_colors(&grid, &[light(-0.4, 0.0)], ZoneStyle::for_intensity(i))[0];
            c[2] / c[0]
        };
        assert!(bleed(3) < bleed(0), "subtle {} vs extreme {}", bleed(0), bleed(3));
    }

    #[test]
    fn watch_point_maps_area_coordinates() {
        assert_eq!(watch_point(&light(-1.0, 1.0)), (0.0, 0.0));
        assert_eq!(watch_point(&light(1.0, -1.0)), (1.0, 1.0));
        assert_eq!(watch_point(&light(0.0, 0.0)), (0.5, 0.5));
    }
}
