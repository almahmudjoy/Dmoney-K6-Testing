
import {
    existsSync,
    readFileSync,
    mkdirSync,
    copyFileSync,
    writeFileSync,
} from 'node:fs';

import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const projectDir = dirname(fileURLToPath(import.meta.url));

// All relative files, backups and reports belong to this K6 project.
process.chdir(projectDir);

const envFile = resolve(projectDir, '.env');
const backendEnvFile = resolve(
    projectDir,
    '..',
    'dmoney-transaction-api',
    '.env'
);

if (!existsSync(envFile)) {
    throw new Error('K6 .env file is missing.');
}

if (!existsSync(backendEnvFile)) {
    throw new Error('Local backend .env file was not found.');
}

// Use the current K6 .env values, not stale values inherited by PowerShell.
const localEnv = parseEnv(readFileSync(envFile, 'utf8'));

for (const [key, value] of Object.entries(localEnv)) {
    process.env[key] = value;
}

const env = localEnv;
const restoreOnly = process.argv[2] === '--restore';
const backendConfig = parseEnv(readFileSync(backendEnvFile, 'utf8'));
const databaseIdentity = {
    host: backendConfig.DB_HOST,
    port: Number(backendConfig.DB_PORT || 3306),
    database: backendConfig.DB_NAME,
};

if (
    !['localhost', '127.0.0.1', '::1'].includes(databaseIdentity.host) ||
    databaseIdentity.database !== 'dmoneydb'
) {
    throw new Error('Database helpers are restricted to local dmoneydb.');
}

if (
    !restoreOnly &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.BASE_URL).hostname)
) {
    throw new Error('Refusing to run against a non-local API.');
}

const requireBackend = createRequire(
    resolve(dirname(backendEnvFile), 'package.json')
);
const mysql = requireBackend('mysql2/promise');
const backupPath = resolve(
    projectDir,
    'config',
    'limits-backup.local.json'
);
const limitLockName = 'dmoney-k6-customer-limits';
const selectCustomerLimits = "SELECT id, role, period, max_amount, max_count, is_active FROM TransactionLimits WHERE role = 'Customer' AND period IN ('daily','monthly') ORDER BY id FOR UPDATE";

function sameLimit(actual, expected) {
    return actual.id === expected.id &&
        actual.role === expected.role &&
        actual.period === expected.period &&
        Number(actual.max_amount) === Number(expected.max_amount) &&
        Number(actual.max_count) === Number(expected.max_count) &&
        Number(actual.is_active) === Number(expected.is_active);
}

function validateBackup(snapshot) {
    if (
        snapshot.identity.host !== databaseIdentity.host ||
        Number(snapshot.identity.port) !== databaseIdentity.port ||
        snapshot.identity.database !== databaseIdentity.database ||
        !Array.isArray(snapshot.rows) || snapshot.rows.length !== 2 ||
        !Array.isArray(snapshot.prepared) || snapshot.prepared.length !== 2
    ) {
        throw new Error('Limit backup is invalid or belongs to another database.');
    }

    for (const original of snapshot.rows) {
        const prepared = snapshot.prepared.find((row) => row.id === original.id);

        if (
            !prepared || original.role !== 'Customer' ||
            !['daily', 'monthly'].includes(original.period) ||
            ![0, 1].includes(Number(original.is_active)) ||
            !Number.isFinite(Number(original.max_amount)) ||
            !Number.isInteger(Number(original.max_count)) ||
            !sameLimit(prepared, {
                ...original,
                max_amount: Math.max(Number(original.max_amount), 1000000),
                max_count: Math.max(Number(original.max_count), 10000),
            })
        ) {
            throw new Error('Limit backup rows failed validation.');
        }
    }
}

async function openLimitDatabase() {
    const db = await mysql.createConnection({
        ...databaseIdentity,
        user: backendConfig.DB_USER,
        password: backendConfig.DB_PASSWORD,
        connectTimeout: 10000,
        multipleStatements: false,
    });

    try {
        const [rows] = await db.execute(
            'SELECT GET_LOCK(?, 0) AS acquired',
            [limitLockName]
        );

        if (Number(rows[0].acquired) !== 1) {
            throw new Error('Another K6 limit operation is already active.');
        }

        return db;
    } catch (error) {
        await db.end();
        throw error;
    }
}

async function restoreSnapshot(db, snapshot) {
    validateBackup(snapshot);
    await db.beginTransaction();

    try {
        const [current] = await db.execute(selectCustomerLimits);

        if (
            current.length !== snapshot.rows.length ||
            current.some((row) =>
                !snapshot.rows.some((original) => sameLimit(row, original)) &&
                !snapshot.prepared.some((prepared) => sameLimit(row, prepared))
            )
        ) {
            throw new Error(
                'Customer limits changed outside this test; refusing to overwrite them.'
            );
        }

        for (const row of snapshot.rows) {
            await db.execute(
                "UPDATE TransactionLimits SET max_amount = ?, max_count = ?, is_active = ? WHERE id = ? AND role = 'Customer' AND period = ?",
                [row.max_amount, row.max_count, row.is_active, row.id, row.period]
            );
        }

        const [after] = await db.execute(selectCustomerLimits);

        if (!after.every((row) => snapshot.rows.some((original) => sameLimit(row, original)))) {
            throw new Error('Customer limit restoration verification failed.');
        }

        await db.commit();
        snapshot.restored = true;
        snapshot.restoredAt = new Date().toISOString();
        writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
        console.log('Original Customer limits restored and verified.');
    } catch (error) {
        await db.rollback();
        throw error;
    }
}

async function restoreBackup() {
    if (!existsSync(backupPath)) {
        console.log('No Customer limit backup exists.');
        return;
    }

    const snapshot = JSON.parse(readFileSync(backupPath, 'utf8'));

    if (snapshot.restored) {
        console.log('Customer limits are already restored.');
        return;
    }

    const db = await openLimitDatabase();

    try {
        await restoreSnapshot(db, snapshot);
    } finally {
        await db.end();
    }
}

async function prepareLimits(runId) {
    if (existsSync(backupPath)) {
        const previous = JSON.parse(readFileSync(backupPath, 'utf8'));

        if (!previous.restored) {
            throw new Error(
                'An unrestored Customer limit backup exists. Run node .\\run-k6-with-limits.mjs --restore first.'
            );
        }
    }

    const db = await openLimitDatabase();
    let snapshot;
    let backupSaved = false;

    try {
        await db.beginTransaction();
        const [rows] = await db.execute(selectCustomerLimits);

        if (
            rows.length !== 2 ||
            new Set(rows.map((row) => row.period)).size !== 2 ||
            rows.some((row) => Number(row.is_active) !== 1)
        ) {
            throw new Error('Expected active daily and monthly Customer limits.');
        }

        const prepared = rows.map((row) => ({
            ...row,
            max_count: Math.max(Number(row.max_count), 10000),
            max_amount: Math.max(Number(row.max_amount), 1000000),
        }));

        snapshot = {
            runId,
            identity: databaseIdentity,
            savedAt: new Date().toISOString(),
            restored: false,
            rows,
            prepared,
        };
        validateBackup(snapshot);
        mkdirSync(dirname(backupPath), { recursive: true });
        writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
        backupSaved = true;

        for (const row of prepared) {
            await db.execute(
                "UPDATE TransactionLimits SET max_amount = ?, max_count = ? WHERE id = ? AND role = 'Customer' AND period = ?",
                [row.max_amount, row.max_count, row.id, row.period]
            );
        }

        const [after] = await db.execute(selectCustomerLimits);

        if (
            after.length !== prepared.length ||
            !after.every((row) => prepared.some((expected) => sameLimit(row, expected)))
        ) {
            throw new Error('Temporary Customer limit update verification failed.');
        }

        await db.commit();
        console.log('Customer limits temporarily raised; original values backed up.');
        return { db, snapshot };
    } catch (error) {
        let rolledBack = false;

        try {
            await db.rollback();
            rolledBack = true;
        } catch (_) {}

        if (backupSaved && rolledBack) {
            snapshot.restored = true;
            snapshot.restoredAt = new Date().toISOString();
            writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
        }

        await db.end();
        throw error;
    }
}

async function restoreLimits(context) {
    const snapshot = JSON.parse(readFileSync(backupPath, 'utf8'));

    if (snapshot.runId !== context.snapshot.runId) {
        throw new Error('Limit backup belongs to a different run.');
    }

    await restoreSnapshot(context.db, snapshot);
}

if (restoreOnly) {
    await restoreBackup();
    process.exit(0);
}

const scriptPath = resolve(
    projectDir,
    process.argv[2] || 'performance-test.js'
);

if (!existsSync(scriptPath)) {
    throw new Error(`k6 script not found: ${scriptPath}`);
}

const required = [
    'BASE_URL',
    'PARTNER_KEY',
    'DEFAULT_OTP',
    'AMOUNT',
    'THINK_TIME_SECONDS',

    'AGENT1_PASSWORD',
    'AGENT1_PHONE',
    'AGENT2_PASSWORD',
    'AGENT2_PHONE',

    'CUSTOMER1_PASSWORD',
    'CUSTOMER1_PHONE',
    'CUSTOMER2_PASSWORD',
    'CUSTOMER2_PHONE',

    'MERCHANT1_PASSWORD',
    'MERCHANT1_PHONE',
    'MERCHANT2_PASSWORD',
    'MERCHANT2_PHONE',
];

const missing = required.filter(
    key => !String(env[key] ?? '').trim()
);

if (missing.length) {
    throw new Error(
        `Missing required K6 settings: ${missing.join(', ')}`
    );
}

const baseUrl = new URL(env.BASE_URL);

if (!['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)) {
    throw new Error('Refusing to run against a non-local API.');
}

if (!process.stdin.isTTY) {
    throw new Error(
        'Run this script in an interactive PowerShell terminal.'
    );
}

const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
});

try {
    console.log('\nLOCAL PERFORMANCE TEST SAFETY CHECK');
    console.log('K6 script:', relative(projectDir, scriptPath));
    console.log('API host:', baseUrl.host);
    console.log('Temporary changes: Customer daily/monthly limits.');
    console.log('Balances and transaction history will NOT be reset.');
    console.log('Stop other API/UI/jobs/test traffic before proceeding.\n');

    const answer = await prompt.question(
        'Type RAISE CUSTOMER LIMITS to continue: '
    );

    if (answer.trim() !== 'RAISE CUSTOMER LIMITS') {
        throw new Error('Cancelled. No limit changes requested.');
    }
} finally {
    prompt.close();
}

const runId = `own-k6-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}`;

const reportsRoot = resolve(projectDir, 'reports');
const runReportDir = resolve(reportsRoot, runId);

mkdirSync(reportsRoot, { recursive: true });
mkdirSync(runReportDir, { recursive: true });

let context;
let child;
let exitCode = 1;
let interrupted = false;
let limitsRestored = false;

const onSignal = () => {
    interrupted = true;

    if (child) {
        child.kill('SIGINT');
    }
};

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
    // Backs up original rules BEFORE applying temporary changes.
    // The helper refuses non-local dmoneydb connections.
    context = await prepareLimits(runId);

    if (interrupted) {
        throw new Error('Interrupted before k6 execution.');
    }

    console.log('\nRunning YOUR K6 script...');
    console.log(`Script: ${scriptPath}`);
    console.log(`Run ID: ${runId}\n`);

    exitCode = await new Promise((resolveExit, reject) => {
        child = spawn(
            'k6',
            ['run', scriptPath],
            {
                cwd: projectDir,
                env: {
                    ...process.env,
                },
                stdio: 'inherit',
            }
        );

        child.once('error', reject);

        child.once('close', (code, signal) => {
            child = undefined;

            if (interrupted) {
                resolveExit(130);
            } else if (signal) {
                resolveExit(1);
            } else {
                resolveExit(code ?? 1);
            }
        });
    });

} catch (error) {
    console.error(`Test runner error: ${error.message}`);
    exitCode = 1;

} finally {
    // Always attempt restoration after a completed preparation.
    if (context) {
        try {
            await restoreLimits(context);
            limitsRestored = true;
        } catch (error) {
            console.error('\nLIMIT RESTORATION FAILED!');
            console.error(error.message);
            console.error('Keep the local backup file.');
            console.error(
                'Recovery commands are shown below.'
            );
            exitCode = 1;
        } finally {
            try {
                await context.db.end();
            } catch (error) {
                console.error(`Could not close limit database connection: ${error.message}`);
                exitCode = 1;
            }
        }
    }

    // Preserve each run's report, even when k6 fails its thresholds.
    const reportFiles = [
        'performance-report.html',
        'summary.json',
    ];

    for (const name of reportFiles) {
        const source = resolve(reportsRoot, name);
        const destination = resolve(runReportDir, name);

        if (existsSync(source)) {
            try {
                copyFileSync(source, destination);
                console.log(`Saved report: ${destination}`);
            } catch (error) {
                console.error(
                    `Could not copy ${name}: ${error.message}`
                );
            }
        } else {
            console.log(`Report not present: ${source}`);
        }
    }

    const metadata = {
        runId,
        script: relative(projectDir, scriptPath),
        exitCode,
        interrupted,
        temporaryLimitsRequested: true,
        limitSettingsRestored: limitsRestored,
        backupPath: relative(projectDir, backupPath),
        reportsDirectory: relative(projectDir, runReportDir),
        note: 'Balances and transaction history are not reset.',
    };

    writeFileSync(
        resolve(runReportDir, 'run-metadata.json'),
        JSON.stringify(metadata, null, 2)
    );

    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);

    console.log(`\nRun reports: ${runReportDir}`);
    console.log(`Limits restored: ${limitsRestored}`);
    console.log(`k6 exit code: ${exitCode}`);

    if (!limitsRestored) {
        console.log('\nRecovery from the K6 folder:');
        console.log(
            '$env:LOCAL_BACKEND_ENV_FILE = ' +
            '(Resolve-Path "..\\dmoney-transaction-api\\.env").Path'
        );
        console.log(
            'node .\\run-k6-with-limits.mjs --restore'
        );
    }
}

process.exitCode = exitCode;
