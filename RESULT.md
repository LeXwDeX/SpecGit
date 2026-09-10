# Native v2 Issue qualification

Source: cee4e05bcd6a203c14ac60ca00945ca03d299990.

- The installed CLI created independent test Issues #539 and #540 after an exact distinct-WHY candidate review.
- Native IDs and submitted bodies were read back.
- Before the source branch existed, the native 404 remained explicitly unknown and no write occurred.
- Once the source branch existed without a diff, request creation returned pending_request with no writes.
- This documentation change gives the isolated request a real reviewable difference.
