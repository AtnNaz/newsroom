// Haberlerin sıralaması: modelin ilgi puanı + okurun geri bildirimiyle öğrenilen konu/kaynak
// eğilimi + olayı kaç kaynağın verdiği − haberin yaşı. Formül bilerek basit tutuldu; her
// bileşen arayüzde "neden üstte" sorusuna açıklanabilir.

export const FEEDBACK_WINDOW_MS = 120 * 24 * 3600_000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Beğeni +1, beğenmeme −1, kaydetme +1 sayılır; son 120 günün toplamı.
export function loadAffinity(db, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT category, source_id, SUM(feedback) + SUM(saved) AS score FROM articles
       WHERE (feedback != 0 OR saved = 1) AND fetched > ? GROUP BY category, source_id`,
    )
    .all(now - FEEDBACK_WINDOW_MS);
  const category = new Map();
  const source = new Map();
  for (const r of rows) {
    if (r.category) category.set(r.category, (category.get(r.category) ?? 0) + r.score);
    source.set(r.source_id, (source.get(r.source_id) ?? 0) + r.score);
  }
  return { category, source };
}

export function scoreParts(a, affinity, now = Date.now()) {
  const hours = Math.max(0, (now - (a.published && a.published < now ? a.published : a.fetched)) / 3600_000);
  return {
    relevance: a.relevance ?? 35,
    topic: clamp(affinity?.category.get(a.category) ?? 0, -5, 5) * 4,
    source: clamp(affinity?.source.get(a.source_id) ?? 0, -5, 5) * 3,
    coverage: Math.min((a.cluster_size ?? 1) - 1, 5) * 3,
    age: -Math.min(40, hours * 0.6),
  };
}

export function scoreArticle(a, affinity, now = Date.now()) {
  const p = scoreParts(a, affinity, now);
  return Math.round(p.relevance + p.topic + p.source + p.coverage + p.age);
}

// Aynı kümedeki haberlerden en yüksek puanlı olan temsilci olur; diğerleri "diğer kaynaklar"
// olarak ona eklenir. Sonuç puana göre sıralı döner.
export function groupClusters(rows, affinity, now = Date.now()) {
  const size = new Map();
  for (const r of rows) {
    const key = r.cluster_id ?? r.id;
    size.set(key, (size.get(key) ?? 0) + 1);
  }
  const groups = new Map();
  for (const r of rows) {
    const key = r.cluster_id ?? r.id;
    const item = { ...r, cluster_size: size.get(key) };
    item.score = scoreArticle(item, affinity, now);
    const g = groups.get(key);
    if (!g) groups.set(key, { lead: item, others: [] });
    else if (item.score > g.lead.score || (item.score === g.lead.score && (item.summary?.length ?? 0) > (g.lead.summary?.length ?? 0))) {
      g.others.push(g.lead);
      g.lead = item;
    } else g.others.push(item);
  }
  return [...groups.values()].sort((a, b) => b.lead.score - a.lead.score);
}
