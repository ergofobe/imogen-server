# Security

imogen holds people's photographs, and gives out access to them over an API. A flaw
here is a serious matter, so thank you for taking the time to report one.

## Reporting a vulnerability

Report it privately, through GitHub:

**[Report a vulnerability →](https://github.com/ergofobe/imogen-server/security/advisories/new)**

That opens a security advisory only the maintainers can see, so the problem can be
fixed before it is described in public. Please don't open a normal issue for it.

Useful things to include:

- what an attacker can reach or do, not only what is broken
- the steps to reproduce it, or a proof of concept
- the commit or image tag you were running
- roughly how it is deployed, when it matters — local accounts or SSO, and what sits
  in front of the server

Please don't attach anyone's real photographs. A file you generated that triggers the
bug is more useful and costs nobody their privacy.

## What happens next

You will get an acknowledgement within a few days, and an honest answer about whether
it is something we can fix and how quickly. If you would like credit in the advisory,
say so and you will have it; if you would rather stay anonymous, that is fine too.

## Supported versions

imogen has not had its first release yet. Fixes land on `main`, and there are no
maintained release branches. If you run the Docker image, move to the current one
before reporting — the bug may already be gone.

## Scope

In scope: the server and its REST API, the OAuth 2.1 authorization server, the web
app, the MCP endpoint, the vault, share links, and the published Docker image.

Out of scope: how you choose to run it. TLS termination, your reverse proxy, database
credentials, file permissions, and the network the server sits on belong to whoever
deploys it. A report that assumes the attacker already has your database or a shell on
your host is describing a compromised server rather than a flaw in imogen.

Automated scanner output on its own is not a report. Tell us what it lets an attacker
do to a running library.
