#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "event-wire.h"

int main(void)
{
    struct bc_user_event ping, pong, bad;
    const char *nonce = "0123456789abcdef0123456789abcdef";
    assert(bc_event_ping(nonce, &ping));
    assert(bc_event_reply(&ping, &pong));
    assert(strcmp(pong.name, BC_EVENT_RESPONSE) == 0);
    assert(strcmp(pong.package, BC_EVENT_NATIVE) == 0);
    assert(strcmp(pong.permissions, BC_EVENT_APP) == 0);
    assert(strcmp(pong.params, "{\"v\":1,\"op\":\"pong\",\"n\":\"0123456789abcdef0123456789abcdef\"}") == 0);
    puts("canonical ping returns the same nonce under the native identity");

    bad = ping; bad.package[0] = 'x'; assert(!bc_event_reply(&bad, &pong));
    bad = ping; bad.name[0] = 'x'; assert(!bc_event_reply(&bad, &pong));
    bad = ping; bad.permissions[0] = 'x'; assert(!bc_event_reply(&bad, &pong));
    memset(&bad, 0xff, sizeof(bad)); assert(!bc_event_reply(&bad, &pong));
    puts("other packages, topics, permissions and unterminated fields are rejected");

    assert(!bc_event_ping("short", &ping));
    assert(!bc_event_ping("0123456789abcdef0123456789abcdeX", &ping));
    assert(!bc_event_ping("0123456789abcdef0123456789abcdef0", &ping));
    assert(!bc_event_ping(NULL, &ping)); assert(!bc_event_ping(nonce, NULL));
    assert(!bc_event_reply(NULL, &pong)); assert(!bc_event_reply(&ping, NULL));
    puts("invalid nonces and null arguments are rejected");

    assert(bc_event_ping(nonce, &ping));
    for (size_t i = 0; i < strlen(ping.params) + 1; ++i) {
        bad = ping; bad.params[i] = (char)0xff;
        assert(!bc_event_reply(&bad, &pong));
    }
    bad = ping; strcpy(bad.params, "{\"v\":1,\"op\":\"start\"}"); assert(!bc_event_reply(&bad, &pong));
    puts("mutated JSON and microphone operations are rejected");

    bc_event_ready(&pong, false);
    assert(strstr(pong.params, "\"rx\":false") != NULL);
    assert(strstr(pong.params, "\"audio\":false") != NULL);
    assert(strlen(pong.params) < sizeof(pong.params));
    puts("startup status cannot advertise recording support");
    return 0;
}
