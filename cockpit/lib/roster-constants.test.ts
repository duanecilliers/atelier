import { describe, expect, it } from 'vitest';
import {
  validateAgentName,
  validateBranchName,
  validateToolName,
  validateWritePattern,
} from '@/lib/roster-constants';

// These validators are security boundaries: branch names and writes patterns
// interpolate into shell hooks / drive the permissions allowlist, so a bad value
// must be rejected before it round-trips.

describe('validateBranchName', () => {
  it('accepts normal and uppercase/underscore names', () => {
    expect(validateBranchName('feat/api-rate-limiting')).toBeNull();
    expect(validateBranchName('feature/PROJ-233_add-field')).toBeNull();
  });

  it('rejects shell metacharacters', () => {
    for (const bad of ['a;rm -rf', 'a$(x)', 'a`x`', 'a b', 'a|b', 'a&b']) {
      expect(validateBranchName(bad)).not.toBeNull();
    }
  });

  it('rejects git-illegal shapes', () => {
    for (const bad of ['', 'a..b', '/x', 'x/', '-x', 'x.lock']) {
      expect(validateBranchName(bad)).not.toBeNull();
    }
  });

  it('rejects an over-long name', () => {
    expect(validateBranchName('a'.repeat(201))).not.toBeNull();
  });
});

describe('validateWritePattern', () => {
  it('accepts repo-relative paths and globs', () => {
    for (const ok of ['specs/', 'docs/**', '*.md', 'app_docs/x.md', 'a/b/*.ts']) {
      expect(validateWritePattern(ok)).toBeNull();
    }
  });

  it('rejects absolute paths (would be a dead rule)', () => {
    expect(validateWritePattern('/etc/passwd')).not.toBeNull();
  });

  it('rejects .. traversal', () => {
    expect(validateWritePattern('../secrets')).not.toBeNull();
    expect(validateWritePattern('a/../b')).not.toBeNull();
  });

  it('rejects disallowed characters', () => {
    expect(validateWritePattern('a b')).not.toBeNull();
    expect(validateWritePattern('a;b')).not.toBeNull();
  });
});

describe('validateToolName', () => {
  it('accepts lowercase tokens', () => {
    expect(validateToolName('read')).toBeNull();
    expect(validateToolName('subagent_create')).toBeNull();
  });
  it('rejects bad tokens', () => {
    for (const bad of ['', 'Read', 'sub-agent', '2tool', 'a b']) {
      expect(validateToolName(bad)).not.toBeNull();
    }
  });
});

describe('validateAgentName', () => {
  it('accepts config-key-safe names', () => {
    expect(validateAgentName('planner')).toBeNull();
    expect(validateAgentName('build-2')).toBeNull();
  });
  it('rejects bad names', () => {
    for (const bad of ['', 'Planner', '2p', 'a'.repeat(41), 'a b']) {
      expect(validateAgentName(bad)).not.toBeNull();
    }
  });
});
