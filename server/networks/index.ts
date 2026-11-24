import type { SOCIAL_NETWORKS } from '../db/schema.js'
import { facebookPage } from './facebook.js'

/**
 * What the publishing engine needs from a social network. Posts are network-agnostic; each network implements this
 * once (Facebook Page now, Instagram later). Methods throw `MetaError` (or a future network's equivalent with the
 * same `kind`) so the engine can tell transient, permanent and unknown failures apart.
 */
export interface NetworkAdapter {
  /** Highest number of images one post may carry on this network. */
  readonly maxImages: number
  readonly maxCaptionLength: number
  publish(input: { token: string; accountExternalId: string; caption: string; imageUrls: string[] }): Promise<PublishedPost>
  /** Recent posts on the account, newest first, for matching a publish whose outcome was unknown. */
  recentPosts(input: { token: string; accountExternalId: string; since: Date }): Promise<RecentPost[]>
  deletePost(input: { token: string; externalPostId: string }): Promise<void>
  /** Confirms the token still works; returns the account's current name and picture. */
  checkHealth(input: { token: string; accountExternalId: string }): Promise<{ name: string; pictureUrl: string | null }>
}

export interface PublishedPost {
  externalPostId: string
  permalink: string | null
}

export interface RecentPost {
  externalPostId: string
  message: string
  createdAt: Date
  permalink: string | null
}

export type Network = (typeof SOCIAL_NETWORKS)[number]

export const adapters: Record<Network, NetworkAdapter> = {
  facebook_page: facebookPage,
}
