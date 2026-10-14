# DMoney K6 Transaction Performance Testing

<p align="center">
	<img src="https://img.shields.io/badge/k6-Performance%20Testing-7D64FF?logo=k6&logoColor=white" alt="k6 Performance Testing">
	<img src="https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript ES6+">
	<img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22 or newer">
	<img src="https://img.shields.io/badge/MySQL-Local%20Test%20Database-4479A1?logo=mysql&logoColor=white" alt="MySQL local test database">
	<img src="https://img.shields.io/badge/HTML-Performance%20Report-E34F26?logo=html5&logoColor=white" alt="HTML performance report">
</p>

A two-minute k6 performance test for the DMoney transaction APIs. The workload uses six dedicated identities, exercises Deposit, Send Money, and Payment, and produces a dashboard-style HTML report with a sanitized JSON summary.

## Project Overview

This project validates the assigned transaction flow under concurrent load. Each actor authenticates with their own credentials, and the sender's token is used for each transaction. Authentication and balance preflight happen before the timed workload; transaction requests are measured during the 120-second test.

## Assignment Workflow

| Time | Concurrent transaction flows |
| --- | --- |
| 0-30 seconds | Customer 1 sends money to Customer 2; Customer 2 pays Merchant 1 |
| 30-60 seconds | Customer 2 sends money to Customer 1; Agent 1 deposits to Customer 2; Customer 1 pays Merchant 1 |
| 60-90 seconds | Agent 1 deposits to Customer 1; Agent 2 deposits to Customer 2; Customer 1 sends money to Customer 2; Customer 2 pays Merchant 2 |
| 90-120 seconds | Agent 1 and Customer 1 pay Merchant 1; Agent 2 and Customer 2 pay Merchant 2 |

Thirteen one-VU scenarios start together within their assigned windows. Each flow waits two seconds after a response, then continues until its 30-second window ends. The configured amount is 10. Successful transactions persist in the local ledger and are not rolled back.

## Technologies Used

- k6 for concurrent workload execution, checks, thresholds, and metrics.
- JavaScript for scenarios, actor authentication, and balance preflight.
- Node.js and MySQL for the guarded local limit backup and restoration runner.
- k6-reporter for the dashboard-style HTML report.

## Project Structure

```text
K6/
|-- .env.example
|-- README.md
|-- performance-test.js
|-- run-k6-with-limits.mjs
|-- generate-report.js
|-- Screenshot/
|   |-- performance-report.png
|   `-- transaction-metrics.png
|-- config/
|   `-- limits-backup.local.json  (local recovery backup; ignored by Git)
`-- reports/
	|-- performance-report.html
	|-- summary.json
	`-- own-k6-<run-id>/
		|-- performance-report.html
		|-- summary.json
		`-- run-metadata.json
```

## Test Coverage

| Coverage item | Result |
| --- | ---: |
| Test identities | 2 Agents, 2 Customers, 2 Merchants |
| Concurrent flow scenarios | 13 |
| Timed workload | 120 seconds |
| Transaction APIs | Deposit, Send Money, Payment |
| Transactions in the final run | 195 |
| Total HTTP requests, including setup | 213 |

## Assertions Implemented

Every transaction response is checked for:

- Expected HTTP status: 201.
- Successful transaction response and the expected success message.
- A non-empty transaction ID.

## Thresholds

Global and separate per-API thresholds enforce:

- HTTP request failure rate below 1%.
- Transaction response p95 below 1000 ms.
- Transaction checks passing at least 99% of the time.

Phase/API thresholds also require traffic coverage and help compare response times as concurrent flows change.

## Running the Test

### Requirements

- Node.js, k6, and MySQL available locally.
- The DMoney API running at the local `BASE_URL`.
- `K6/.env` configured with partner key, OTP, amount, and credentials for all six test users. Start with `.env.example` if needed.
- The backend's installed `mysql2` driver for the guarded local limit runner.
- Internet access on first k6 run to download the HTML reporter.

### Execute

From the workspace root, enter the K6 folder and start the guarded run:

```powershell
Set-Location .\K6
node .\run-k6-with-limits.mjs .\performance-test.js
```

When prompted, stop other API/test traffic and enter `RAISE CUSTOMER LIMITS`. The runner checks all six balances and planned Customer deposit capacity before starting, temporarily adjusts local Customer limits, and restores/verifies them afterward. It does not reverse transaction effects.

If interrupted before restoration, recover the original limits with:

```powershell
node .\run-k6-with-limits.mjs --restore
```

To regenerate the styled HTML from the existing sanitized summary without sending transactions:

```powershell
k6 run .\generate-report.js
```

## Final Run Results

Run `own-k6-2026-10-14T14-31-53-951Z` completed the full 120-second workload with exit code 0. All 13 scenarios completed their assigned windows with no interrupted iterations. The run had zero failed HTTP requests, zero failed transaction checks, zero breached thresholds, and the runner restored and verified the original Customer limits.

| API | Requests | Throughput (req/s) | Average response (ms) | p95 (ms) | Failure rate | Checks passed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Deposit | 45 | 0.750 | 34.72 | 60.90 | 0% | 100% |
| Send Money | 45 | 0.500 | 49.13 | 90.63 | 0% | 100% |
| Payment | 105 | 0.875 | 44.59 | 106.00 | 0% | 100% |

Throughput uses each API's scheduled active duration: Deposit 60 seconds, Send Money 90 seconds, and Payment 120 seconds.

| Workload phase | Concurrent flows | Deposit p95 (ms) | Send Money p95 (ms) | Payment p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| 0-30 seconds | 2 | N/A | 104.34 | 102.59 |
| 30-60 seconds | 3 | 142.83 | 151.25 | 154.03 |
| 60-90 seconds | 4 | 55.00 | 62.28 | 72.47 |
| 90-120 seconds | 4 | N/A | N/A | 107.91 |

The highest phase/API p95 was Payment in phase 2 at 154.03 ms. Latency increased in phase 2, then decreased in phase 3 as concurrency rose to four flows; there was no sustained degradation, and every API remained below the 1000 ms threshold. These results represent one local run, not a production-capacity claim.

## HTML Report

[Open the final dashboard report](reports/own-k6-2026-10-14T14-31-53-951Z/performance-report.html) or view the [sanitized JSON summary](reports/own-k6-2026-10-14T14-31-53-951Z/summary.json).

![Final k6 dashboard report](Screenshot/performance-report.png)

## Metrics Screenshot

![Final API and phase metrics](Screenshot/transaction-metrics.png)

## Git Ignore

The local `.env`, logs, and `config/limits-backup.local.json` are excluded from Git. Keep real credentials and local database backups out of the repository.

## Author

Abdullah Al Mahmud Joy

- Full Stack SDET, Road to SDET.
- M.Sc. in Computer Science and Engineering, Military Institute of Science and Technology (MIST).
- B.Sc. in Computer Science and Engineering, Bangladesh University of Business and Technology (BUBT).
- GitHub: [almahmudjoy](https://github.com/almahmudjoy).
- LinkedIn: [Abdullah Al Mahmud Joy](https://www.linkedin.com/in/abdullah-al-mahmud-joy/).
