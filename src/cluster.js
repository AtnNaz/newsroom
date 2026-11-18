// Aynı olayı anlatan haberleri bir araya toplar. Gömme modeli varsa vektörlerin kosinüs
// benzerliği, yoksa başlık ve etiketlerdeki kelime köklerinin örtüşmesi (Jaccard) kullanılır.

export const EMBED_THRESHOLD = 0.8;
export const TOKEN_THRESHOLD = 0.42;
export const CLUSTER_WINDOW_MS = 48 * 3600_000;

const STOP = new Set(
  (
    've veya ile için gibi daha çok bir iki üç bu şu o da de ki mi mı mu mü ne ama fakat ancak olan olarak oldu olduğu ' +
    'yeni son sonra önce kadar göre karşı arasında üzerinde içinde yüzde milyon milyar bin hakkında açıkladı dedi ' +
    'the a an and or of to in on at for with from by as is are was were be been has have had it its this that these ' +
    'new says said after before over into about more than will can could may not no how why what who when'
  ).split(/\s+/),
);

// Türkçe eklemeli bir dil olduğu için kelimelerin ilk 6 harfi kök yerine kullanılır. Büyük harfli
// yazımlar (NVIDIA / Nvidia) aynı sonuca insin diye noktasız ı, i'ye çevrilir.
export function titleTokens(...parts) {
  const out = new Set();
  for (const part of parts.flat()) {
    for (const w of String(part ?? '')
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)) {
      if (w.length >= 3 && !STOP.has(w)) out.add(w.slice(0, 6));
    }
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const toBlob = (v) => (v ? new Uint8Array(new Float32Array(v).buffer) : null);
export const fromBlob = (b) => (b && b.byteLength ? new Float32Array(new Uint8Array(b).buffer) : null);

const parseTags = (t) => {
  if (Array.isArray(t)) return t;
  try {
    return JSON.parse(t ?? '[]');
  } catch {
    return [];
  }
};

// Yeni analiz edilen haberin kümesini bulur: en benzer adayın kümesine katılır, yoksa kendi
// kümesini başlatır. Adaylar aynı zaman penceresindeki analiz edilmiş haberlerdir.
export function chooseCluster(article, candidates) {
  const ea = fromBlob(article.embedding);
  const ta = titleTokens(article.title_local || article.title, parseTags(article.tags));
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.id === article.id) continue;
    const ec = fromBlob(c.embedding);
    let score;
    if (ea && ec && ea.length === ec.length) {
      const s = cosine(ea, ec);
      score = s >= EMBED_THRESHOLD ? s : 0;
    } else {
      const s = jaccard(ta, titleTokens(c.title_local || c.title, parseTags(c.tags)));
      score = s >= TOKEN_THRESHOLD ? s : 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ? (best.cluster_id ?? best.id) : article.id;
}
