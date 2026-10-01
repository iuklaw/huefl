// The HueStream v2 packet - what goes over the DTLS stream to the bridge.
//
// Layout (all multi-byte values big-endian):
//   "HueStream"           9 bytes, ASCII
//   version               2 bytes: 0x02 0x00
//   sequence id           1 byte (informational, wraps)
//   reserved              2 bytes: 0x00 0x00
//   color space           1 byte: 0x00 RGB, 0x01 XY + brightness
//   reserved              1 byte: 0x00
//   entertainment config  36 bytes: the configuration's UUID as ASCII
//   channels              7 bytes each, up to 20:
//                           channel id (1) + three 16-bit values
//
// Pure - no I/O - so it is tested byte for byte.

pub const MAX_CHANNELS: usize = 20;
const HEADER_LEN: usize = 16;
const CONFIG_ID_LEN: usize = 36;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorSpace {
    Rgb = 0x00,
    /// Part of the format; the effects send RGB, so only tests use it so far.
    #[allow(dead_code)]
    Xy = 0x01,
}

/// One channel's color: RGB, or x / y / brightness, each scaled to 0..=65535.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelColor {
    pub channel_id: u8,
    pub values: [u16; 3],
}

impl ChannelColor {
    /// From RGB components in 0.0..=1.0 (clamped).
    pub fn rgb(channel_id: u8, r: f32, g: f32, b: f32) -> Self {
        let scale = |v: f32| (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
        Self { channel_id, values: [scale(r), scale(g), scale(b)] }
    }
}

pub fn encode(
    sequence: u8,
    config_id: &str,
    space: ColorSpace,
    channels: &[ChannelColor],
) -> Result<Vec<u8>, String> {
    if config_id.len() != CONFIG_ID_LEN || !config_id.is_ascii() {
        return Err(format!("invalid entertainment configuration id: {config_id}"));
    }
    if channels.len() > MAX_CHANNELS {
        return Err(format!("too many channels: {} (max {MAX_CHANNELS})", channels.len()));
    }

    let mut packet = Vec::with_capacity(HEADER_LEN + CONFIG_ID_LEN + channels.len() * 7);
    packet.extend_from_slice(b"HueStream");
    packet.extend_from_slice(&[0x02, 0x00, sequence, 0x00, 0x00, space as u8, 0x00]);
    packet.extend_from_slice(config_id.as_bytes());
    for channel in channels {
        packet.push(channel.channel_id);
        for value in channel.values {
            packet.extend_from_slice(&value.to_be_bytes());
        }
    }
    Ok(packet)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1a8d99cc-967b-44f2-9202-43f976c0fa6b";

    #[test]
    fn golden_packet() {
        let packet = encode(
            7,
            ID,
            ColorSpace::Rgb,
            &[
                ChannelColor { channel_id: 0, values: [0xFFFF, 0x0000, 0x8000] },
                ChannelColor { channel_id: 2, values: [0x0001, 0x0203, 0x0405] },
            ],
        )
        .unwrap();

        let mut expected = b"HueStream".to_vec();
        expected.extend_from_slice(&[0x02, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00]);
        expected.extend_from_slice(ID.as_bytes());
        expected.extend_from_slice(&[0x00, 0xFF, 0xFF, 0x00, 0x00, 0x80, 0x00]);
        expected.extend_from_slice(&[0x02, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
        assert_eq!(packet, expected);
        assert_eq!(packet.len(), 16 + 36 + 2 * 7);
    }

    #[test]
    fn xy_color_space_flag() {
        let packet = encode(0, ID, ColorSpace::Xy, &[]).unwrap();
        assert_eq!(packet[14], 0x01);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(encode(0, "short", ColorSpace::Rgb, &[]).is_err());
        let many = vec![ChannelColor { channel_id: 0, values: [0; 3] }; MAX_CHANNELS + 1];
        assert!(encode(0, ID, ColorSpace::Rgb, &many).is_err());
    }

    #[test]
    fn rgb_scaling_clamps() {
        assert_eq!(ChannelColor::rgb(1, 1.5, -0.2, 0.5).values, [65535, 0, 32768]);
    }
}
