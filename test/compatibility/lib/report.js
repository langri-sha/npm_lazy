'use strict';

// Collects scenario outcomes and renders them as a compatibility matrix.

const fs = require('fs');

const STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
  XFAIL: 'xfail', // known defect, reproduced on purpose
  SKIP: 'skip',
};

const SYMBOL = {
  pass: 'PASS ',
  fail: 'FAIL ',
  xfail: 'XFAIL',
  skip: 'SKIP ',
};

class Report {
  constructor() {
    this.results = [];
    this.meta = {};
    this.startedAt = new Date();
  }

  setMeta(key, value) {
    this.meta[key] = value;
  }

  record(entry) {
    this.results.push(entry);
    const detail = entry.detail ? ' — ' + entry.detail : '';
    process.stdout.write(SYMBOL[entry.status] + ' ' + entry.id + ' ' + entry.title + detail + '\n');
    return entry;
  }

  // Wraps a scenario so an unexpected throw is a failure rather than a crash.
  async scenario(id, title, fn, options) {
    const opts = options || {};
    const started = Date.now();

    try {
      const outcome = (await fn()) || {};
      return this.record({
        id: id,
        title: title,
        group: opts.group,
        status: outcome.status || STATUS.PASS,
        detail: outcome.detail,
        evidence: outcome.evidence,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      return this.record({
        id: id,
        title: title,
        group: opts.group,
        status: STATUS.FAIL,
        detail: err.message,
        evidence: { stack: err.stack },
        durationMs: Date.now() - started,
      });
    }
  }

  skip(id, title, reason, group) {
    return this.record({ id: id, title: title, group: group, status: STATUS.SKIP, detail: reason });
  }

  counts() {
    return this.results.reduce(
      function (acc, result) {
        acc[result.status] = (acc[result.status] || 0) + 1;
        return acc;
      },
      { pass: 0, fail: 0, xfail: 0, skip: 0 }
    );
  }

  get failed() {
    return this.counts().fail > 0;
  }

  markdown() {
    const rows = this.results.map(function (result) {
      const detail = (result.detail || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');
      return (
        '| ' + result.id +
        ' | ' + (result.group || '') +
        ' | ' + result.title +
        ' | ' + result.status.toUpperCase() +
        ' | ' + detail +
        ' |'
      );
    });

    return [
      '| ID | Group | Scenario | Result | Detail |',
      '| --- | --- | --- | --- | --- |',
    ].concat(rows).join('\n');
  }

  write(jsonPath) {
    const counts = this.counts();
    const payload = {
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      meta: this.meta,
      counts: counts,
      results: this.results,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  }

  printSummary() {
    const counts = this.counts();
    process.stdout.write('\n' + this.markdown() + '\n');
    process.stdout.write(
      '\n' + counts.pass + ' passed, ' + counts.fail + ' failed, ' +
      counts.xfail + ' known defects reproduced, ' + counts.skip + ' skipped\n'
    );
  }
}

module.exports = { Report: Report, STATUS: STATUS };
