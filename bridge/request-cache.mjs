/** Bounded retry window. Active calls are never evicted or executed twice. */
export class RequestCache extends Map {
  constructor({limit=256, ttlMs=60000, now=Date.now}={}) {
    super();Object.assign(this,{limit,ttlMs,now});
  }
  reserve(id, entry) {
    for (const [key,value] of this) {
      if (value.settled && this.now()-value.startedAt>=this.ttlMs) this.delete(key);
    }
    while (this.size>=this.limit) {
      const oldest=[...this].find(([,value])=>value.settled);
      if (!oldest) throw new Error('手机请求繁忙，请稍后重试');
      this.delete(oldest[0]);
    }
    this.set(id,entry);
  }
}
