import { TwitterApi } from 'twitter-api-v2';
import { config } from './config.js';

let _client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (!_client) {
    _client = new TwitterApi({
      appKey: config.xAppKey,
      appSecret: config.xAppSecret,
      accessToken: config.xAccessToken,
      accessSecret: config.xAccessSecret,
    });
  }
  return _client;
}

// Returns the tweet ID on success, null on dry-run or error
export async function postTweet(text: string): Promise<string | null> {
  if (config.dryRun) {
    console.log(`[alert:dry-run] (${text.length} chars)\n${text}\n`);
    return null;
  }
  try {
    const res = await getClient().v2.tweet(text);
    console.log(`[alert:posted] ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    console.error('[alert:twitter]', err instanceof Error ? err.message : err);
    return null;
  }
}

// Posts a thread — each element is a tweet, each replies to the previous
export async function postThread(tweets: string[]): Promise<string[]> {
  if (tweets.length === 0) return [];

  if (config.dryRun) {
    tweets.forEach((t, i) => console.log(`[alert:dry-run:thread:${i + 1}/${tweets.length}] (${t.length} chars)\n${t}\n`));
    return [];
  }

  const ids: string[] = [];
  let replyToId: string | undefined;

  for (const text of tweets) {
    try {
      const payload = replyToId
        ? { text, reply: { in_reply_to_tweet_id: replyToId } }
        : { text };
      const res = await getClient().v2.tweet(payload);
      ids.push(res.data.id);
      replyToId = res.data.id;
      // Small pause between thread tweets to avoid rate limit
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error('[alert:twitter:thread]', err instanceof Error ? err.message : err);
      break;
    }
  }

  console.log(`[alert:posted:thread] ${ids.length}/${tweets.length} tweets`);
  return ids;
}
