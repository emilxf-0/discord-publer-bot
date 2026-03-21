/**
 * Publer API helpers for uploading media and creating draft posts.
 */

const PUBLER_BASE = 'https://app.publer.com/api/v1';
const WORKSPACE_NAME = process.env.PUBLER_WORKSPACE_NAME || 'emil';

/** Comma-separated providers to exclude (e.g. "twitter" if Twitter blocks drafts) */
const EXCLUDED_PROVIDERS = new Set(
  (process.env.PUBLER_EXCLUDE_PROVIDERS || '')
    .toLowerCase()
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
);

function getHeaders(workspaceId) {
  return {
    'Authorization': `Bearer-API ${process.env.PUBLER_API_KEY}`,
    'Publer-Workspace-Id': workspaceId,
    'Content-Type': 'application/json',
  };
}

/**
 * Find the workspace by name and fetch all its accounts.
 * Returns { workspaceId, accountIds }.
 */
async function getWorkspaceAndAccounts() {
  const headers = {
    'Authorization': `Bearer-API ${process.env.PUBLER_API_KEY}`,
  };

  const workspaces = await fetch(`${PUBLER_BASE}/workspaces`, { headers }).then((r) => r.json());
  if (!Array.isArray(workspaces)) {
    throw new Error(workspaces?.errors?.[0] || 'Failed to fetch workspaces');
  }

  const workspace = workspaces.find(
    (w) => w.name?.toLowerCase() === WORKSPACE_NAME.toLowerCase()
  );
  if (!workspace) {
    throw new Error(`Workspace "${WORKSPACE_NAME}" not found. Available: ${workspaces.map((w) => w.name).join(', ')}`);
  }

  const accountHeaders = { ...headers, 'Publer-Workspace-Id': workspace.id };
  const accountRes = await fetch(`${PUBLER_BASE}/accounts`, { headers: accountHeaders }).then((r) => r.json());
  const accounts = accountRes?.accounts ?? (Array.isArray(accountRes) ? accountRes : []);
  const activeAccounts = accounts
    .filter((a) => !a.status || a.status === 'active')
    .filter((a) => a.id && a.provider);

  if (activeAccounts.length === 0) {
    throw new Error(`No active accounts in workspace "${WORKSPACE_NAME}"`);
  }

  return { workspaceId: workspace.id, accounts: activeAccounts };
}

/**
 * Upload media from URLs (Discord attachment/embed URLs).
 * items: [{ url, name, type: 'image'|'video' }]
 * Returns { ids: string[], types: string[] }.
 */
async function uploadMediaFromUrls(items, workspaceId) {
  if (items.length === 0) return { ids: [], types: [] };

  const mediaItems = items.map(({ url, name, type }) => ({
    url,
    name: name || `${type || 'file'}-${Date.now()}.${type === 'video' ? 'mp4' : 'png'}`,
  }));

  const res = await fetch(`${PUBLER_BASE}/media/from-url`, {
    method: 'POST',
    headers: getHeaders(workspaceId),
    body: JSON.stringify({
      media: mediaItems,
      type: items.length > 1 ? 'bulk' : 'single',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.errors?.[0] || `Publer upload failed: ${res.status}`);
  }

  const { job_id } = await res.json();
  const ids = await pollMediaJob(job_id, workspaceId);
  if (items.length > 0 && ids.length === 0) {
    throw new Error('Media upload completed but no media IDs returned (Discord URLs may have expired). Try forwarding quickly after posting.');
  }
  const types = items.map((i) => i.type || 'image');
  return { ids, types };
}

/**
 * Poll job status until complete, return media IDs.
 */
async function pollMediaJob(jobId, workspaceId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${PUBLER_BASE}/job_status/${jobId}`, {
      headers: getHeaders(workspaceId),
    });

    if (!res.ok) {
      throw new Error(`Job status check failed: ${res.status}`);
    }

    const data = await res.json();
    const status = data?.data?.status ?? data?.data?.result?.status ?? data?.status;

    if (status === 'complete' || status === 'completed') {
      const payload = data?.data?.result?.payload ?? data?.data?.payload ?? data?.payload ?? {};
      return extractMediaIds(payload);
    }

    if (status === 'failed') {
      const payload = data?.data?.result?.payload ?? data?.payload ?? {};
      const failures = payload.failures || payload.errors || [];
      const msg = Array.isArray(failures) ? failures.join(', ') : JSON.stringify(failures);
      throw new Error(`Media upload failed: ${msg || 'Unknown error'}`);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error('Media upload timed out');
}

function extractMediaIds(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map((m) => m?.id).filter(Boolean);
  }
  if (payload.media && Array.isArray(payload.media)) {
    return payload.media.map((m) => m?.id).filter(Boolean);
  }
  if (payload.results && Array.isArray(payload.results)) {
    return payload.results.map((m) => m?.id).filter(Boolean);
  }
  if (payload.id) return [payload.id];
  if (payload.media_ids && Array.isArray(payload.media_ids)) return payload.media_ids;
  return [];
}

/**
 * Publer provider names (from API) to networks key.
 */
const PROVIDER_TO_NETWORK = {
  facebook: 'facebook',
  instagram: 'instagram',
  twitter: 'twitter',
  linkedin: 'linkedin',
  pinterest: 'pinterest',
  google: 'google',
  tiktok: 'tiktok',
  youtube: 'youtube',
  telegram: 'telegram',
  mastodon: 'mastodon',
  threads: 'threads',
  bluesky: 'bluesky',
};

/** Networks that require media (no text-only posts). */
const MEDIA_REQUIRED = new Set(['instagram', 'tiktok', 'pinterest', 'youtube']);

/**
 * Create a draft post in Publer. Polls job status and throws on failure.
 * Uses explicit network keys per provider (default doesn't work for all accounts).
 * For text-only messages, excludes Instagram/TikTok/Pinterest/YouTube (they require media).
 * mediaResult: { ids: string[], types: string[] } - types are 'image' or 'video'
 */
async function createDraftPost(text, mediaResult, workspaceId, accounts) {
  const { ids: mediaIds, types: mediaTypes } = mediaResult;
  const hasMedia = mediaIds.length > 0;
  const hasVideo = mediaTypes.includes('video');
  const postType = !hasMedia ? 'status' : hasVideo ? 'video' : mediaIds.length > 1 ? 'carousel' : 'photo';

  let accountsToUse = hasMedia
    ? accounts
    : accounts.filter((a) => !MEDIA_REQUIRED.has(a.provider));

  // Exclude providers via PUBLER_EXCLUDE_PROVIDERS (e.g. "twitter")
  accountsToUse = accountsToUse.filter((a) => !EXCLUDED_PROVIDERS.has(a.provider));

  // One account per provider (Twitter/X blocks duplicate content across multiple accounts)
  const seen = new Set();
  accountsToUse = accountsToUse.filter((a) => {
    if (seen.has(a.provider)) return false;
    seen.add(a.provider);
    return true;
  });

  if (accountsToUse.length === 0) {
    throw new Error(
      hasMedia ? 'No valid accounts' : 'Text-only posts cannot go to Instagram, TikTok, Pinterest, or YouTube. Add an image to the message.'
    );
  }

  const baseContent = {
    type: postType,
    text: text || '(no caption)',
  };

  if (hasMedia) {
    baseContent.media = mediaIds.map((id, i) => {
      const t = mediaTypes[i] || 'image';
      return {
        id,
        type: t === 'video' ? 'video' : 'image',
        ...(t === 'image' && { alt_text: 'Image from Discord' }),
      };
    });
  }

  const providers = [...new Set(accountsToUse.map((a) => a.provider).filter(Boolean))];
  const networkKey = (p) => PROVIDER_TO_NETWORK[p] || p;
  const networks = {};
  for (const provider of providers) {
    const key = networkKey(provider);
    if (key) networks[key] = { ...baseContent };
  }

  if (Object.keys(networks).length === 0) {
    throw new Error('No valid network providers found in accounts');
  }

  const res = await fetch(`${PUBLER_BASE}/posts/schedule`, {
    method: 'POST',
    headers: getHeaders(workspaceId),
    body: JSON.stringify({
      bulk: {
        state: 'draft',
        posts: [
          {
            networks,
            accounts: accountsToUse.map((a) => ({ id: a.id })),
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.errors?.[0] || `Publer create post failed: ${res.status}`);
  }

  const data = await res.json();
  const jobId = data?.data?.job_id ?? data?.job_id;
  if (!jobId) {
    throw new Error('No job_id from Publer');
  }

  await pollPostJob(jobId, workspaceId);
  return jobId;
}

/**
 * Poll post creation job until complete. Throws on failure.
 */
async function pollPostJob(jobId, workspaceId, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${PUBLER_BASE}/job_status/${jobId}`, {
      headers: getHeaders(workspaceId),
    });

    if (!res.ok) {
      throw new Error(`Job status check failed: ${res.status}`);
    }

    const data = await res.json();
    const status = data?.data?.status ?? data?.data?.result?.status ?? data?.status;

    if (status === 'complete' || status === 'completed') {
      const payload = data?.data?.result?.payload ?? data?.data?.payload ?? data?.payload ?? {};
      const failures = payload.failures;
      if (failures && typeof failures === 'object' && Object.keys(failures).length > 0) {
        const msg = Array.isArray(failures) ? failures.map((f) => f.message || f).join('; ') : JSON.stringify(failures);
        throw new Error(`Publer draft failed: ${msg}`);
      }
      if (failures && Array.isArray(failures) && failures.length > 0) {
        const msg = failures.map((f) => f.message || f.account_name || JSON.stringify(f)).join('; ');
        throw new Error(`Publer draft failed: ${msg}`);
      }
      return;
    }

    if (status === 'failed') {
      const payload = data?.data?.result?.payload ?? data?.payload ?? {};
      const failures = payload.failures || payload.errors || [];
      const msg = Array.isArray(failures) ? failures.map((f) => f.message || f).join('; ') : JSON.stringify(failures);
      throw new Error(`Publer draft failed: ${msg || 'Unknown error'}`);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error('Publer draft creation timed out');
}

/**
 * Create an Idea in Publer (no accounts - choose channels when using it).
 * Uses draft_public so it appears in the Ideas tab. No accounts = you pick channels manually.
 */
async function createIdea(text, mediaResult, workspaceId) {
  const { ids: mediaIds, types: mediaTypes } = mediaResult;
  const hasMedia = mediaIds.length > 0;
  const hasVideo = mediaTypes.includes('video');
  const postType = !hasMedia ? 'status' : hasVideo ? 'video' : mediaIds.length > 1 ? 'carousel' : 'photo';

  const defaultContent = {
    type: postType,
    text: text || '(no caption)',
  };

  if (hasMedia) {
    defaultContent.media = mediaIds.map((id, i) => {
      const t = mediaTypes[i] || 'image';
      return {
        id,
        type: t === 'video' ? 'video' : 'image',
        ...(t === 'image' && { alt_text: 'Image from Discord' }),
      };
    });
  }

  const res = await fetch(`${PUBLER_BASE}/posts/schedule`, {
    method: 'POST',
    headers: getHeaders(workspaceId),
    body: JSON.stringify({
      bulk: {
        state: process.env.PUBLER_IDEA_PRIVATE === 'true' ? 'draft_private' : 'draft_public',
        posts: [
          {
            networks: { default: defaultContent },
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.errors?.[0] || `Publer create idea failed: ${res.status}`);
  }

  const data = await res.json();
  const jobId = data?.data?.job_id ?? data?.job_id;
  if (!jobId) {
    throw new Error('No job_id from Publer');
  }

  await pollPostJob(jobId, workspaceId);
  return jobId;
}

module.exports = {
  getWorkspaceAndAccounts,
  uploadMediaFromUrls,
  createDraftPost,
  createIdea,
};
