'use strict';

/**
 * Finding vocabulary.
 *
 * Every fact this tool emits carries two labels so a reader can never mistake
 * an inference for a measurement:
 *   - confidence: observed | inferred | documented | unknown
 *   - method:     how the value was obtained
 *
 * `unknown` is a first-class answer. When the tool cannot establish something
 * statically it says so instead of guessing.
 */

const CONFIDENCE = Object.freeze({
  OBSERVED: 'observed', // read directly from this machine right now
  INFERRED: 'inferred', // derived from observed facts, with a stated rule
  DOCUMENTED: 'documented', // from a cited external source, not measured here
  UNKNOWN: 'unknown', // could not be established
});

const METHOD = Object.freeze({
  FILE_READ: 'file-read',
  DIR_ENUM: 'dir-enum',
  REGISTRY_READ: 'registry-read',
  PROCESS_ENUM: 'process-enum',
  SERVICE_ENUM: 'service-enum',
  SCHEDULED_TASK_ENUM: 'scheduled-task-enum',
  VERSION_CMD: 'version-cmd',
  INFERRED: 'inferred',
  EXTERNAL_DOC: 'external-doc',
  NOT_OBSERVED: 'not-observed',
});

/** Build an evidence pointer. */
function ev(type, ref, detail) {
  const e = { type, ref };
  if (detail) e.detail = detail;
  return e;
}

function observed(value, method, evidence = [], note) {
  const f = { value, confidence: CONFIDENCE.OBSERVED, method, evidence };
  if (note) f.note = note;
  return f;
}

function inferred(value, method, evidence = [], note) {
  const f = { value, confidence: CONFIDENCE.INFERRED, method, evidence };
  if (note) f.note = note;
  return f;
}

function documented(value, evidence = [], note) {
  const f = { value, confidence: CONFIDENCE.DOCUMENTED, method: METHOD.EXTERNAL_DOC, evidence };
  if (note) f.note = note;
  return f;
}

function unknown(reason, method = METHOD.NOT_OBSERVED) {
  return { value: null, confidence: CONFIDENCE.UNKNOWN, method, note: reason };
}

const CONFIDENCE_RANK = {
  observed: 3,
  inferred: 2,
  documented: 1,
  unknown: 0,
};

module.exports = {
  CONFIDENCE,
  METHOD,
  CONFIDENCE_RANK,
  ev,
  observed,
  inferred,
  documented,
  unknown,
};
