package dev.bandcodex.bt;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/** Xiaomi SAR v2 L1 startup only; no binding, authentication, or app commands. */
public final class L1Handshake {
    private L1Handshake() {}

    public static int crc(byte[] payload) {
        int value = 0;
        for (byte item : payload) {
            value ^= item & 255;
            for (int i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) == 0 ? 0 : 0xa001);
        }
        return value;
    }

    private static void tlv(ByteArrayOutputStream out, int key, byte[] value) {
        out.write(key); out.write(value.length & 255); out.write(value.length >>> 8);
        out.write(value, 0, value.length);
    }

    public static byte[] start() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(1); // CmdL1startReq
        tlv(out, 1, new byte[]{1, 0, 0});
        tlv(out, 2, new byte[]{0, (byte)252}); // MPS 64512
        tlv(out, 3, new byte[]{32, 0});
        tlv(out, 4, new byte[]{16, 39}); // 10,000 ms
        byte[] payload = out.toByteArray(), packet = new byte[8 + payload.length];
        packet[0] = packet[1] = (byte)0xa5; packet[2] = 2; // CMD, FRX=false, seq=0
        packet[4] = (byte)payload.length; packet[5] = (byte)(payload.length >>> 8);
        int check = crc(payload); packet[6] = (byte)check; packet[7] = (byte)(check >>> 8);
        System.arraycopy(payload, 0, packet, 8, payload.length);
        return packet;
    }

    public static final class Decoder {
        private final ByteArrayOutputStream received = new ByteArrayOutputStream();
        private int consumed;
        public boolean started;
        public int validFrames, badCrc;

        public void append(byte[] input, int length) {
            if (length < 0 || length > input.length || received.size() + length > 8192)
                throw new IllegalArgumentException("Invalid or excessive L1 input");
            received.write(input, 0, length);
            byte[] bytes = received.toByteArray();
            while (bytes.length - consumed >= 8) {
                if ((bytes[consumed] & 255) != 0xa5 || (bytes[consumed + 1] & 255) != 0xa5)
                    throw new IllegalArgumentException("Unexpected L1 stream prefix");
                int size = (bytes[consumed + 4] & 255) | ((bytes[consumed + 5] & 255) << 8);
                if (size > 8184) throw new IllegalArgumentException("Excessive L1 frame");
                if (bytes.length - consumed < size + 8) return;
                int expected = (bytes[consumed + 6] & 255) | ((bytes[consumed + 7] & 255) << 8);
                byte[] payload = Arrays.copyOfRange(bytes, consumed + 8, consumed + 8 + size);
                if (crc(payload) != expected) { badCrc++; throw new IllegalArgumentException("L1 CRC mismatch"); }
                validFrames++;
                if ((bytes[consumed + 2] & 15) == 2 && size > 0 && payload[0] == 2) {
                    int offset = 1;
                    while (offset < size) {
                        if (size - offset < 3) throw new IllegalArgumentException("Truncated L1 configuration");
                        int valueSize = (payload[offset + 1] & 255) | ((payload[offset + 2] & 255) << 8);
                        offset += 3 + valueSize;
                        if (offset > size) throw new IllegalArgumentException("Truncated L1 configuration value");
                    }
                    started = true;
                }
                consumed += 8 + size;
            }
        }
    }
}
