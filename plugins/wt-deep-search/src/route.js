const CLAUDE_PRODUCT_PATTERN = /\bclaude\s*code\b|\bclaude\.md\b|(?:^|[\s\\/])\.claude(?:[\s\\/]|$)/i;
const CLAUDE_IDENTIFIER_PATTERN =
  /\b(pretooluse|posttooluse|permissionrequest|subagentstop|sessionstart|sessionend|userpromptsubmit|precompact|frontmatter|slash\s*commands?|mcp\s*servers?|sub-?agents?|output\s*styles?|allowed-tools)\b/i;

// WEAK evidence: a noun this product uses constantly, which on its own proves nothing. It
// CONSULTS the mirror rather than deciding for it — the mirror is local and free, so being
// wrong there costs milliseconds and falls through, while skipping it costs a paid call and a
// worse answer. Asymmetric costs, so the cheap side takes the doubt.
const CLAUDE_WEAK_PATTERN =
  /\b(changelog|hooks?|skills?|agents?|settings?|permissions?|plugins?|formatter|transcripts?|marketplace|worktrees?)\b/i;

// A foreign brand never vetoes STRONG evidence; it settles a WEAK one. A React hook and an
// eslint plugin are someone else's documentation.
const FOREIGN_PRODUCT_PATTERN =
  /\b(react|vue|svelte|angular|next\.?js|node|npm|pnpm|git|github|docker|kubernetes|python|django|rails|webpack|vite|eslint|prettier|tailwind|postgres|mysql|redis|aws|gcp|azure)\b/i;

function claudeEvidence(query) {
  if (CLAUDE_PRODUCT_PATTERN.test(query) || CLAUDE_IDENTIFIER_PATTERN.test(query)) return 'strong';
  if (CLAUDE_WEAK_PATTERN.test(query) && !FOREIGN_PRODUCT_PATTERN.test(query)) return 'weak';
  return null;
}

function isClaudeCodeQuestion(query) {
  return CLAUDE_PRODUCT_PATTERN.test(query)
    || CLAUDE_IDENTIFIER_PATTERN.test(query);
}
const DEEP_RESEARCH_PATTERN =
  /\b(comprehensive|in[- ]depth|literature review|deep research|investigate|synthesi[sz]e|multiple sources|trade-?offs?|competing theories|compare\b.{0,40}\bevidence|evaluate\b.{0,40}\bevidence)\b/i;

function noProvider(reason) {
  return { provider: 'none', reason, call: null };
}

function opencode(query, provider, reason) {
  if (provider?.available !== true) return noProvider(reason);
  return {
    provider: 'opencode',
    reason,
    call: {
      command: provider.path ?? 'opencode',
      args: ['run', query],
    },
  };
}

export function route(question, providers, deps = {}) {
  const query = String(question ?? '');
  const availableProviders = providers && typeof providers === 'object' ? providers : {};

  if (!query.trim()) {
    return noProvider('Question must be a non-empty value');
  }

  const evidence = claudeEvidence(query);
  if (evidence) {
    if (availableProviders.mirror?.available !== true) {
      return noProvider(
        `Claude Code documentation mirror is unavailable: ${availableProviders.mirror?.reason ?? 'not configured'}`,
      );
    }
    if (typeof availableProviders.mirror.path !== 'string' || !availableProviders.mirror.path.trim()) {
      return noProvider('Claude Code documentation mirror path is not configured');
    }

    return {
      provider: 'mirror',
      // 'strong' answers; 'weak' consults, and the caller falls through to the ordinary web
      // search when the mirror returns nothing relevant.
      confidence: evidence,
      reason: evidence === 'strong'
        ? 'Claude Code questions use the free local documentation mirror'
        : 'The question may be about Claude Code: the free local mirror is consulted first',
      call: { path: availableProviders.mirror.path, query },
    };
  }

  const isDeep = DEEP_RESEARCH_PATTERN.test(query);

  if (!isDeep) {
    if (availableProviders.brave?.available === true) {
      if (deps.exhaustion?.isExhausted?.('brave')) {
        return noProvider('Brave is exhausted; use the ordinary web search');
      }
      return {
        provider: 'brave',
        reason: 'Brave is the preferred provider for a simple search',
        call: { query, options: {} },
      };
    }

    if (availableProviders.exa?.available === true) {
      if (deps.exhaustion?.isExhausted?.('exa')) {
        return opencode(
          query,
          availableProviders.opencode,
          'Exa is exhausted; cascade to the opencode research provider',
        );
      }
      return {
        provider: 'exa',
        reason: 'Exa fast search is the cheapest available simple-search fallback',
        call: { query, options: { type: 'fast' } },
      };
    }

    return noProvider('No Brave or Exa provider is available for a simple search');
  }

  return opencode(
    query,
    availableProviders.opencode,
    availableProviders.opencode?.available === true
      ? 'Explicit deep research uses the opencode research provider'
      : 'opencode is not available for deep research',
  );
}
