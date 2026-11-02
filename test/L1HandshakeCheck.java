package dev.bandcodex.bt;

import java.util.Arrays;

public final class L1HandshakeCheck {
    public static void main(String[] args) {
        if (L1Handshake.crc("123456789".getBytes()) != 0xbb3d) throw new AssertionError("CRC-16/ARC vector");
        byte[] response = L1Handshake.start(); response[8] = 2;
        int crc = L1Handshake.crc(Arrays.copyOfRange(response, 8, response.length));
        response[6] = (byte)crc; response[7] = (byte)(crc >>> 8);
        for (int cut = 0; cut <= response.length; cut++) {
            L1Handshake.Decoder decoder = new L1Handshake.Decoder();
            decoder.append(Arrays.copyOfRange(response, 0, cut), cut);
            decoder.append(Arrays.copyOfRange(response, cut, response.length), response.length-cut);
            if (!decoder.started || decoder.validFrames != 1) throw new AssertionError("Fragmented response");
        }
        L1Handshake.Decoder notResponse = new L1Handshake.Decoder(); byte[] request = L1Handshake.start();
        notResponse.append(request, request.length);
        if (notResponse.started) throw new AssertionError("Request is not a response");
        response[response.length-1] ^= 1;
        try { new L1Handshake.Decoder().append(response, response.length); throw new AssertionError("Bad CRC accepted"); }
        catch (IllegalArgumentException expected) {}
        System.out.println("CRC vector, all split points, request rejection, corrupt response: passed");
    }
}
