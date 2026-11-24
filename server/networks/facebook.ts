import type { NetworkAdapter, RecentPost } from './index.js'
import { graph, MetaError } from './metaClient.js'

/**
 * Facebook Page publishing through the Graph API (docs/meta-graph-api.md).
 * - Text only: `POST /{page}/feed` with `message`.
 * - One photo: `POST /{page}/photos` with `url` and `message`; Meta fetches the image from our public media URL.
 * - Several photos: each uploaded unpublished (`published=false`), then one `/feed` post with `attached_media`.
 *   Unpublished photos left behind by a failed attempt are invisible and harmless.
 */

const FACEBOOK_CAPTION_LIMIT = 63_206

async function permalinkOf(token: string, postId: string): Promise<string | null> {
  // Best effort: the post exists even if this lookup fails, so a failure here never fails the publish.
  try {
    const res = await graph<{ permalink_url?: string }>({ path: `/${postId}`, params: { fields: 'permalink_url' }, token })
    return res.permalink_url ?? null
  } catch {
    return null
  }
}

export const facebookPage: NetworkAdapter = {
  maxImages: 10,
  maxCaptionLength: FACEBOOK_CAPTION_LIMIT,

  async publish({ token, accountExternalId: page, caption, imageUrls }) {
    let postId: string
    if (imageUrls.length === 0) {
      postId = (await graph<{ id: string }>({ method: 'POST', path: `/${page}/feed`, params: { message: caption }, token })).id
    } else if (imageUrls.length === 1) {
      const res = await graph<{ id: string; post_id?: string }>({
        method: 'POST',
        path: `/${page}/photos`,
        params: { url: imageUrls[0], message: caption || undefined, published: true },
        token,
      })
      postId = res.post_id ?? `${page}_${res.id}`
    } else {
      const photoIds: string[] = []
      for (const url of imageUrls) {
        // Uploading an unpublished photo can't create a visible post, so a lost answer here is safe to retry.
        try {
          photoIds.push((await graph<{ id: string }>({ method: 'POST', path: `/${page}/photos`, params: { url, published: false }, token })).id)
        } catch (error) {
          if (error instanceof MetaError && error.kind === 'unknown') throw new MetaError('transient', error.message)
          throw error
        }
      }
      const params: Record<string, string> = { message: caption }
      photoIds.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })))
      postId = (await graph<{ id: string }>({ method: 'POST', path: `/${page}/feed`, params, token })).id
    }
    return { externalPostId: postId, permalink: await permalinkOf(token, postId) }
  },

  async recentPosts({ token, accountExternalId: page, since }) {
    const res = await graph<{ data: { id: string; message?: string; created_time: string; permalink_url?: string }[] }>({
      path: `/${page}/posts`,
      params: { fields: 'id,message,created_time,permalink_url', since: Math.floor(since.getTime() / 1000), limit: 50 },
      token,
    })
    return res.data.map(
      (p): RecentPost => ({ externalPostId: p.id, message: p.message ?? '', createdAt: new Date(p.created_time), permalink: p.permalink_url ?? null }),
    )
  },

  async deletePost({ token, externalPostId }) {
    await graph({ method: 'DELETE', path: `/${externalPostId}`, token })
  },

  async checkHealth({ token, accountExternalId: page }) {
    const res = await graph<{ id: string; name: string; picture?: { data?: { url?: string } } }>({
      path: `/${page}`,
      params: { fields: 'id,name,picture{url}' },
      token,
    })
    return { name: res.name, pictureUrl: res.picture?.data?.url ?? null }
  },
}
