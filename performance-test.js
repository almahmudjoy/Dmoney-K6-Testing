
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

// ------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const PARTNER_KEY = __ENV.PARTNER_KEY;
const AMOUNT = Number(__ENV.AMOUNT);
const THINK_TIME = Number(__ENV.THINK_TIME_SECONDS);

const EXPECTED_MESSAGES = {
    deposit: 'Deposit successful',
    sendmoney: 'Send money successful',
    payment: 'Payment successful',
};

const transactionContractPass = new Rate('transaction_contract_pass');
const transactionFailureRate = new Rate('transaction_failure_rate');

// All actor/API/phase combinations required by the assignment.
const phaseApiPairs = [
    { phase: 'phase1', api: 'sendmoney' },
    { phase: 'phase1', api: 'payment' },

    { phase: 'phase2', api: 'sendmoney' },
    { phase: 'phase2', api: 'deposit' },
    { phase: 'phase2', api: 'payment' },

    { phase: 'phase3', api: 'deposit' },
    { phase: 'phase3', api: 'sendmoney' },
    { phase: 'phase3', api: 'payment' },

    { phase: 'phase4', api: 'payment' },
];

// ------------------------------------------------------
// THRESHOLDS
// ------------------------------------------------------

const thresholds = {
    // All HTTP requests, including authentication.
    http_req_failed: ['rate<0.01'],

    // Transaction endpoint response times.
    'http_req_duration{type:transaction}': ['p(95)<1000'],

    // Transaction assertions and semantic success.
    'checks{kind:transaction}': ['rate>=0.99'],
    transaction_contract_pass: ['rate>=0.99'],
    transaction_failure_rate: ['rate<0.01'],
};

for (const api of ['deposit', 'sendmoney', 'payment']) {
    thresholds[`http_req_duration{api:${api}}`] = ['p(95)<1000'];
    thresholds[`http_req_failed{api:${api}}`] = ['rate<0.01'];
    thresholds[`http_reqs{api:${api}}`] = ['count>0'];
    thresholds[`transaction_contract_pass{api:${api}}`] = ['rate>=0.99'];
    thresholds[`transaction_failure_rate{api:${api}}`] = ['rate<0.01'];
    thresholds[`checks{kind:transaction,api:${api}}`] = ['rate>=0.99'];
}

// Phase-specific thresholds make degradation easier to identify.
for (const item of phaseApiPairs) {
    const selector = `{api:${item.api},phase:${item.phase}}`;

    thresholds[`http_req_duration${selector}`] = ['p(95)<1000'];
    thresholds[`http_req_failed${selector}`] = ['rate<0.01'];
    thresholds[`http_reqs${selector}`] = ['count>0'];

    thresholds[`transaction_contract_pass${selector}`] = ['rate>=0.99'];
    thresholds[`transaction_failure_rate${selector}`] = ['rate<0.01'];

    thresholds[
        `checks{kind:transaction,api:${item.api},phase:${item.phase}}`
    ] = ['rate>=0.99'];
}

// ------------------------------------------------------
// 13 CONCURRENT FLOWS, FOUR TIMED PHASES
// ------------------------------------------------------

const flows = [
    // PHASE 1: 0-30 seconds
    { name: 'p1Customer1SendMoney', phase: 'phase1', startTime: '0s' },
    { name: 'p1Customer2PaymentMerchant1', phase: 'phase1', startTime: '0s' },

    // PHASE 2: 30-60 seconds
    { name: 'p2Customer2SendMoney', phase: 'phase2', startTime: '30s' },
    { name: 'p2Agent1DepositCustomer2', phase: 'phase2', startTime: '30s' },
    { name: 'p2Customer1PaymentMerchant1', phase: 'phase2', startTime: '30s' },

    // PHASE 3: 60-90 seconds
    { name: 'p3Agent1DepositCustomer1', phase: 'phase3', startTime: '60s' },
    { name: 'p3Agent2DepositCustomer2', phase: 'phase3', startTime: '60s' },
    { name: 'p3Customer1SendMoney', phase: 'phase3', startTime: '60s' },
    { name: 'p3Customer2PaymentMerchant2', phase: 'phase3', startTime: '60s' },

    // PHASE 4: 90-120 seconds
    { name: 'p4Agent1PaymentMerchant1', phase: 'phase4', startTime: '90s' },
    { name: 'p4Agent2PaymentMerchant2', phase: 'phase4', startTime: '90s' },
    { name: 'p4Customer1PaymentMerchant1', phase: 'phase4', startTime: '90s' },
    { name: 'p4Customer2PaymentMerchant2', phase: 'phase4', startTime: '90s' },
];

const scenarios = {};

for (const flow of flows) {
    scenarios[flow.name] = {
        executor: 'constant-vus',
        exec: flow.name,
        vus: 1,
        duration: '30s',
        startTime: flow.startTime,

        // Avoid long-running iterations extending into later phases.
        gracefulStop: '1s',

        tags: {
            phase: flow.phase,
        },
    };
}

export const options = {
    scenarios,
    thresholds,
};

// ------------------------------------------------------
// AUTHENTICATION
// Runs once in setup(), outside the timed transaction phases.
// ------------------------------------------------------

const actors = [
    {
        key: 'agent1',
        name: 'Agent 1',
        phone: __ENV.AGENT1_PHONE,
        password: __ENV.AGENT1_PASSWORD,
        role: 'Agent',
    },
    {
        key: 'agent2',
        name: 'Agent 2',
        phone: __ENV.AGENT2_PHONE,
        password: __ENV.AGENT2_PASSWORD,
        role: 'Agent',
    },
    {
        key: 'customer1',
        name: 'Customer 1',
        phone: __ENV.CUSTOMER1_PHONE,
        password: __ENV.CUSTOMER1_PASSWORD,
        role: 'Customer',
    },
    {
        key: 'customer2',
        name: 'Customer 2',
        phone: __ENV.CUSTOMER2_PHONE,
        password: __ENV.CUSTOMER2_PASSWORD,
        role: 'Customer',
    },
    {
        key: 'merchant1',
        name: 'Merchant 1',
        phone: __ENV.MERCHANT1_PHONE,
        password: __ENV.MERCHANT1_PASSWORD,
        role: 'Merchant',
    },
    {
        key: 'merchant2',
        name: 'Merchant 2',
        phone: __ENV.MERCHANT2_PHONE,
        password: __ENV.MERCHANT2_PASSWORD,
        role: 'Merchant',
    },
];

const jsonHeaders = {
    'Content-Type': 'application/json',
};

function parseJson(response) {
    try {
        return response.json();
    } catch (_) {
        return {};
    }
}

function authenticate(actor) {
    if (!actor.phone || !actor.password) {
        throw new Error(`${actor.name}: missing local configuration.`);
    }

    const login = http.post(
        `${BASE_URL}/user/login?env=dev`,
        JSON.stringify({
            phone_number: actor.phone,
            password: actor.password,
        }),
        {
            headers: jsonHeaders,
            tags: {
                type: 'auth',
                auth_step: 'login',
                actor: actor.key,
            },
        }
    );

    if (login.status !== 200) {
        throw new Error(`${actor.name}: login HTTP ${login.status}.`);
    }

    const otp = http.post(
        `${BASE_URL}/user/verify-otp?env=dev`,
        JSON.stringify({
            identifier: actor.phone,
            otp: __ENV.DEFAULT_OTP,
        }),
        {
            headers: jsonHeaders,
            tags: {
                type: 'auth',
                auth_step: 'otp',
                actor: actor.key,
            },
        }
    );

    const body = parseJson(otp);

    if (
        otp.status !== 200 ||
        typeof body.token !== 'string' ||
        !body.token ||
        body.role !== actor.role
    ) {
        throw new Error(
            `${actor.name}: OTP verification/token validation failed; HTTP ${otp.status}.`
        );
    }

    return body.token;
}

function preflightBalance(actor, token) {
    const response = http.get(
        `${BASE_URL}/transaction/balance/${encodeURIComponent(actor.phone)}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-AUTH-SECRET-KEY': PARTNER_KEY,
            },
            tags: {
                type: 'preflight',
                actor: actor.key,
            },
        }
    );
    const body = parseJson(response);
    const balance = Number(body.balance);

    if (response.status !== 200 || !Number.isFinite(balance)) {
        throw new Error(
            `${actor.name}: balance preflight failed; HTTP ${response.status}.`
        );
    }

    return balance;
}

export function setup() {
    if (!BASE_URL.startsWith('http://localhost:')) {
        throw new Error(
            'Safety check: BASE_URL must point to the local test API.'
        );
    }

    if (!PARTNER_KEY) {
        throw new Error('PARTNER_KEY is missing.');
    }

    if (!Number.isFinite(AMOUNT) || AMOUNT < 10) {
        throw new Error('AMOUNT must be at least 10.');
    }

    if (!Number.isFinite(THINK_TIME) || THINK_TIME <= 0) {
        throw new Error('THINK_TIME_SECONDS must be positive.');
    }

    const tokens = {};

    for (const actor of actors) {
        tokens[actor.key] = authenticate(actor);
    }

    const iterationsPerFlow = Math.ceil(30 / THINK_TIME);
    const paymentCost = AMOUNT + Math.max(AMOUNT * 0.01, 5);
    const sendMoneyCost = AMOUNT + 5;
    const plannedDebits = {
        agent1: 2 * iterationsPerFlow * AMOUNT + iterationsPerFlow * paymentCost,
        agent2: iterationsPerFlow * AMOUNT + iterationsPerFlow * paymentCost,
        customer1: 2 * iterationsPerFlow * sendMoneyCost +
            2 * iterationsPerFlow * paymentCost,
        customer2: iterationsPerFlow * sendMoneyCost +
            3 * iterationsPerFlow * paymentCost,
    };
    const balances = {};

    for (const actor of actors) {
        balances[actor.key] = preflightBalance(actor, tokens[actor.key]);

        if (
            plannedDebits[actor.key] !== undefined &&
            balances[actor.key] < plannedDebits[actor.key]
        ) {
            throw new Error(
                `${actor.name}: balance ${balances[actor.key].toFixed(2)} is below the estimated ${plannedDebits[actor.key].toFixed(2)} required for this workload (short by ${(plannedDebits[actor.key] - balances[actor.key]).toFixed(2)}); no transactions were sent.`
            );
        }
    }

    const customerBalanceCap = 10000;
    const depositCapacity = {
        customer1: iterationsPerFlow * AMOUNT,
        customer2: 2 * iterationsPerFlow * AMOUNT,
    };

    for (const customerKey of Object.keys(depositCapacity)) {
        if (balances[customerKey] + depositCapacity[customerKey] > customerBalanceCap) {
            throw new Error(
                `${customerKey}: planned deposits may exceed the local balance cap; no transactions were sent.`
            );
        }
    }

    console.log('All six actors authenticated successfully.');
    console.log('Balance and deposit-capacity preflight passed.');
    console.log('Starting the 120-second transaction workload.');

    return { tokens };
}

// ------------------------------------------------------
// REUSABLE TRANSACTION FUNCTION
// ------------------------------------------------------

function runTransaction(
    data,
    api,
    senderKey,
    senderPhone,
    recipientPhone,
    phase,
    flow
) {
    const response = http.post(
        `${BASE_URL}/transaction/${api}`,
        JSON.stringify({
            from_account: senderPhone,
            to_account: recipientPhone,
            amount: AMOUNT,
        }),
        {
            headers: {
                ...jsonHeaders,
                Authorization: `Bearer ${data.tokens[senderKey]}`,
                'X-AUTH-SECRET-KEY': PARTNER_KEY,
            },
            tags: {
                type: 'transaction',
                api,
                phase,
                flow,
            },
        }
    );

    const body = parseJson(response);
    const expectedMessage = EXPECTED_MESSAGES[api];

    const hasTransactionId =
        typeof body.trnxId === 'string' && body.trnxId.length > 0;

    const messageMatches = body.message === expectedMessage;
    const statusMatches = response.status === 201;

    const allPassed =
        statusMatches && messageMatches && hasTransactionId;

    const tags = {
        kind: 'transaction',
        api,
        phase,
        flow,
    };

    check(
        response,
        {
            [`${flow}: HTTP 201`]:
                () => statusMatches,

            [`${flow}: expected success message`]:
                () => messageMatches,

            [`${flow}: transaction ID returned`]:
                () => hasTransactionId,

            [`${flow}: transaction completed successfully`]:
                () => allPassed,
        },
        tags
    );

    transactionContractPass.add(allPassed, tags);
    transactionFailureRate.add(!allPassed, tags);

    if (!allPassed) {
        console.error(
            `${flow} failed: HTTP ${response.status}; message=${body.message || 'missing'}`
        );
    }

    // Keep the configured pacing between requests in this flow.
    sleep(THINK_TIME);
}

// ------------------------------------------------------
// PHASE 1 FUNCTIONS: 0-30 seconds
// ------------------------------------------------------

export function p1Customer1SendMoney(data) {
    runTransaction(
        data, 'sendmoney', 'customer1',
        __ENV.CUSTOMER1_PHONE, __ENV.CUSTOMER2_PHONE,
        'phase1', 'p1_customer1_sendmoney'
    );
}

export function p1Customer2PaymentMerchant1(data) {
    runTransaction(
        data, 'payment', 'customer2',
        __ENV.CUSTOMER2_PHONE, __ENV.MERCHANT1_PHONE,
        'phase1', 'p1_customer2_payment_merchant1'
    );
}

// ------------------------------------------------------
// PHASE 2 FUNCTIONS: 30-60 seconds
// ------------------------------------------------------

export function p2Customer2SendMoney(data) {
    runTransaction(
        data, 'sendmoney', 'customer2',
        __ENV.CUSTOMER2_PHONE, __ENV.CUSTOMER1_PHONE,
        'phase2', 'p2_customer2_sendmoney'
    );
}

export function p2Agent1DepositCustomer2(data) {
    runTransaction(
        data, 'deposit', 'agent1',
        __ENV.AGENT1_PHONE, __ENV.CUSTOMER2_PHONE,
        'phase2', 'p2_agent1_deposit_customer2'
    );
}

export function p2Customer1PaymentMerchant1(data) {
    runTransaction(
        data, 'payment', 'customer1',
        __ENV.CUSTOMER1_PHONE, __ENV.MERCHANT1_PHONE,
        'phase2', 'p2_customer1_payment_merchant1'
    );
}

// ------------------------------------------------------
// PHASE 3 FUNCTIONS: 60-90 seconds
// ------------------------------------------------------

export function p3Agent1DepositCustomer1(data) {
    runTransaction(
        data, 'deposit', 'agent1',
        __ENV.AGENT1_PHONE, __ENV.CUSTOMER1_PHONE,
        'phase3', 'p3_agent1_deposit_customer1'
    );
}

export function p3Agent2DepositCustomer2(data) {
    runTransaction(
        data, 'deposit', 'agent2',
        __ENV.AGENT2_PHONE, __ENV.CUSTOMER2_PHONE,
        'phase3', 'p3_agent2_deposit_customer2'
    );
}

export function p3Customer1SendMoney(data) {
    runTransaction(
        data, 'sendmoney', 'customer1',
        __ENV.CUSTOMER1_PHONE, __ENV.CUSTOMER2_PHONE,
        'phase3', 'p3_customer1_sendmoney'
    );
}

export function p3Customer2PaymentMerchant2(data) {
    runTransaction(
        data, 'payment', 'customer2',
        __ENV.CUSTOMER2_PHONE, __ENV.MERCHANT2_PHONE,
        'phase3', 'p3_customer2_payment_merchant2'
    );
}

// ------------------------------------------------------
// PHASE 4 FUNCTIONS: 90-120 seconds
// ------------------------------------------------------

export function p4Agent1PaymentMerchant1(data) {
    runTransaction(
        data, 'payment', 'agent1',
        __ENV.AGENT1_PHONE, __ENV.MERCHANT1_PHONE,
        'phase4', 'p4_agent1_payment_merchant1'
    );
}

export function p4Agent2PaymentMerchant2(data) {
    runTransaction(
        data, 'payment', 'agent2',
        __ENV.AGENT2_PHONE, __ENV.MERCHANT2_PHONE,
        'phase4', 'p4_agent2_payment_merchant2'
    );
}

export function p4Customer1PaymentMerchant1(data) {
    runTransaction(
        data, 'payment', 'customer1',
        __ENV.CUSTOMER1_PHONE, __ENV.MERCHANT1_PHONE,
        'phase4', 'p4_customer1_payment_merchant1'
    );
}

export function p4Customer2PaymentMerchant2(data) {
    runTransaction(
        data, 'payment', 'customer2',
        __ENV.CUSTOMER2_PHONE, __ENV.MERCHANT2_PHONE,
        'phase4', 'p4_customer2_payment_merchant2'
    );
}

// ------------------------------------------------------
// TEARDOWN
// ------------------------------------------------------

export function teardown(data) {
    console.log('Performance test completed. Token values withheld.');
}

// ------------------------------------------------------
// HTML + JSON SUMMARY REPORT
// ------------------------------------------------------

export function handleSummary(data) {
    const safeSummary = {
        metrics: data.metrics || {},
        root_group: {
            ...data.root_group,
            checks: data.root_group && data.root_group.checks
                ? data.root_group.checks
                : [],
            groups: data.root_group && data.root_group.groups
                ? data.root_group.groups
                : [],
        },
        state: data.state || {},
        options: {
            summaryTrendStats: data.options && data.options.summaryTrendStats
                ? data.options.summaryTrendStats
                : ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)'],
            summaryTimeUnit: data.options && data.options.summaryTimeUnit
                ? data.options.summaryTimeUnit
                : '',
        },
    };

    const dashboardHtml = htmlReport(safeSummary, {
        title: 'DMoney Transaction Performance Report',
    });

    return {
        'reports/performance-report.html': dashboardHtml,
        'reports/summary.json': JSON.stringify(safeSummary, null, 2),
    };
}
