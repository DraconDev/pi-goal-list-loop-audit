#!/usr/bin/env node
import { readProgressReport } from '../extensions/progress-reader.mjs';
import { formatProgressReport } from '../extensions/progress-report.mjs';

const args = process.argv.slice(2);
if (args.length < 2 || args[0] !== '--state-dir' || !args[1] || args.length > 3 || (args[2] && args[2] !== '--text')) {
  console.error('Usage: node scripts/glla-progress-report.mjs --state-dir <selected-state-root> [--text]');
  process.exitCode = 2;
} else {
  try {
    const report = readProgressReport(args[1]);
    console.log(args[2] === '--text' ? formatProgressReport(report) : JSON.stringify(report, null, 2));
    if (report.source.errors.length) process.exitCode = 1;
  } catch {
    console.error('Progress report unavailable: invalid or inaccessible selected state root.');
    process.exitCode = 1;
  }
}
