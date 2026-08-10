import { describe, expect, it } from 'vitest';
import { inferAdw } from '@/lib/adws';

// inferAdw is a decision table that routes free-text intent to an ADW. The
// buildish-negation precedence is the subtle part: an ask that is both "explain"
// and "add" is build work, not recon.

describe('inferAdw', () => {
  it('routes read-only recon to scout', () => {
    expect(inferAdw('where is auth handled')).toBe('adw_scout');
    expect(inferAdw('explain how the worker drains the queue')).toBe('adw_scout');
    expect(inferAdw('audit the seam contract')).toBe('adw_scout');
  });

  it('buildish wins over recon words', () => {
    // "explain" + "add" -> build work, not scout
    expect(inferAdw('explain the flow then add a health endpoint')).toBe('adw_plan_build');
  });

  it('routes review/document to the full sdlc', () => {
    expect(inferAdw('review the changes')).toBe('adw_simple_sdlc');
    expect(inferAdw('document the API')).toBe('adw_simple_sdlc');
    expect(inferAdw('ship it')).toBe('adw_simple_sdlc');
  });

  it('routes test/sdlc to plan_build_test', () => {
    // note: \btest\b matches "test"/"sdlc" as whole words (not "tests")
    expect(inferAdw('add a test for the parser')).toBe('adw_plan_build_test');
    expect(inferAdw('run the full sdlc')).toBe('adw_simple_sdlc');
  });

  it('routes a plan-only ask to plan', () => {
    expect(inferAdw('plan the migration')).toBe('adw_plan');
  });

  it('defaults to plan_build for generic build work', () => {
    expect(inferAdw('add a copy button to the sandbox card')).toBe('adw_plan_build');
    expect(inferAdw('refactor the reader')).toBe('adw_plan_build');
  });
});
