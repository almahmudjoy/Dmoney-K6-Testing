import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

const summary = JSON.parse(open('./reports/summary.json'));

export const options = {
    vus: 1,
    iterations: 1,
};

export default function () {}

export function handleSummary() {
    return {
        'reports/performance-report.html': htmlReport(summary, {
            title: 'DMoney Transaction Performance Report',
        }),
    };
}
