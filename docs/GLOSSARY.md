# Glossary

Stellar and point-of-sale terms used in this codebase and its docs. Where a
term maps to code, the file or column is named so you can jump straight to it.

## Stellar terms

| Term | Meaning | In this repo |
|---|---|---|
| **Account** | A Stellar address (starts with `G…`) holding balances. The merchant receives payments into one account. | `STELLAR_MERCHANT_PUBLIC_KEY` in [ENVIRONMENT.md](ENVIRONMENT.md) |
| **Anchor** | A regulated business that issues assets on Stellar and exchanges them for off-chain money (for example a bank or exchange that issues USDC and pays out fiat). | Not integrated. The merchant handles off-ramping themselves. |
| **Asset** | Any token on Stellar. Identified by an **asset code** plus an **issuer**, except the native asset XLM. | `asset_code`, `asset_issuer` on `payment_requests` |
| **Asset code** | The short ticker of an asset, such as `USDC`. Two assets with the same code but different issuers are different assets. | `STELLAR_ASSET_CODE` |
| **Clawback** | An issuer-enabled feature that lets the issuer take an asset back from a holder's account. A payment that was later clawed back no longer sits in the merchant's account. | Not handled. Matching only looks at incoming payments. |
| **Cursor / paging token** | Horizon's position marker in a stream of operations. Passing it back resumes exactly after the last record seen. | Stored in the `kv` table by [`paymentWatcher.ts`](../src/services/paymentWatcher.ts) |
| **DEX** | Stellar's built-in decentralised exchange. Path payments convert through it. | See *path payment* |
| **Federation** | A protocol (SEP-0002) that maps a human-readable address like `alice*example.com` to a `G…` account. | Not used. Only raw `G…` accounts are accepted. |
| **Horizon** | The HTTP API server for reading from and submitting to the Stellar network. | [`horizon.ts`](../src/services/horizon.ts) is the only module that calls it; `STELLAR_HORIZON_URL` |
| **Issuer** | The account that created an asset. Checking the issuer, not just the code, stops look-alike tokens being accepted as payment. | `STELLAR_ASSET_ISSUER`, checked in [`checkout.service.ts`](../src/services/checkout.service.ts) |
| **Mainnet / Testnet** | The live Stellar network and the free test network. They are separate ledgers with separate **network passphrases**. | `STELLAR_NETWORK` |
| **Memo** | A short note attached to a transaction. A text memo is at most 28 bytes. This backend puts a unique code in it to tie an on-chain payment to a sale. | `payment_requests.memo` (`SP` + 10 characters, `UNIQUE`) |
| **Network passphrase** | A string that identifies which network a transaction is signed for, so a testnet signature is invalid on mainnet. | Added to SEP-7 URIs off mainnet |
| **Non-custodial** | The backend never holds a secret key and can never move funds. It only observes payments to the merchant account. | See [stellar-payments.md](stellar-payments.md) |
| **Path payment** | A payment where the sender pays in one asset and the receiver gets another, converted through the DEX. The *destination* asset and amount are what count. | Handled by the watcher and matcher |
| **SEP** | Stellar Ecosystem Proposal: a standard built on top of the core protocol. | SEP-0007 is the one used here |
| **SEP-0007 (SEP-7)** | A URI scheme (`web+stellar:pay?...`) that wallets understand. Encoded as a QR code at checkout. | Built in [`stellar.service.ts`](../src/services/stellar.service.ts) |
| **Stroop** | The smallest unit of a Stellar amount: 1 unit = 10,000,000 stroops (7 decimal places). Amounts are handled as integer stroops so no float rounding ever touches money. | [`utils/money.ts`](../src/utils/money.ts) (`STROOPS_PER_UNIT`, `toStroops`, `fromStroops`) |
| **Transaction hash** | The unique ID of a submitted Stellar transaction. Used to look a payment up on Horizon and to stop one payment settling two sales. | `payments.stellar_tx_hash` (`UNIQUE`) |
| **Trustline** | An account's explicit opt-in to hold a non-native asset. The merchant account must have a USDC trustline before it can receive USDC. | Setup step in [DEVELOPMENT.md](DEVELOPMENT.md) |
| **USDC** | A dollar-pegged stablecoin issued on Stellar. A common choice for `STELLAR_ASSET_CODE`. | |
| **XLM (lumens)** | Stellar's native asset. Has no issuer. | |

## Point-of-sale terms

| Term | Meaning | In this repo |
|---|---|---|
| **Cents** | All store-currency money is stored as integer minor units (`*_cents` columns), never as decimals. | `price_cents`, `total_cents`, `paid_cents` |
| **Cashier / Manager / Admin** | Staff roles, from least to most privileged. Routes are guarded by role. | `users.role` |
| **Payment request** | A one-off Stellar checkout for a sale: destination, asset, amount, memo and expiry. Status is `pending`, `paid`, `expired` or `cancelled`. | `payment_requests` table |
| **Payment method** | How a payment was taken: `cash`, `card` or `stellar`. One sale can have several payments (split tender). | `payments.method` |
| **Receipt** | The customer-facing record of a completed sale, which can be emailed. | [`receipt.service.ts`](../src/services/receipt.service.ts) |
| **Refund** | Reversing a completed sale. The sale moves to `refunded`. A Stellar refund has to be sent from the merchant's wallet, since the backend holds no keys. | `transactions.status` |
| **Sale / Transaction** | A customer purchase with line items, discount, tax and total. Not to be confused with a *Stellar* transaction. Status is `pending`, `completed`, `void` or `refunded`. | `transactions` table |
| **Settlement** | The moment a matched on-chain payment is recorded against a sale, completing it when the balance reaches zero. | `handleIncomingPayment` in [`checkout.service.ts`](../src/services/checkout.service.ts) |
| **Split tender** | Paying for one sale with more than one payment or method. | Multiple `payments` rows per sale |
| **Terminal** | A cashier's device running the POS front end. Receives live updates over Socket.IO. | [`realtime.ts`](../src/services/realtime.ts) |
| **Void** | Cancelling a sale before it is paid. The sale moves to `void`. | `transactions.status` |
