import { clip, s, text, type FleetTool } from "./kit.js";

/**
 * Glossary translation: phrase and word lookup from a fixed dictionary.
 * Honest sandbox quality for short UI strings, product labels and support
 * snippets. Unknown words pass through and are listed in `untranslated`.
 */
type Target = "es" | "ca" | "fr";

// english: [spanish, catalan, french]
const PHRASES: Record<string, [string, string, string]> = {
  "thank you": ["gracias", "gràcies", "merci"],
  "good morning": ["buenos días", "bon dia", "bonjour"],
  "good afternoon": ["buenas tardes", "bona tarda", "bon après-midi"],
  "good night": ["buenas noches", "bona nit", "bonne nuit"],
  "how are you": ["cómo estás", "com estàs", "comment allez-vous"],
  "sign in": ["iniciar sesión", "inicia la sessió", "se connecter"],
  "sign up": ["registrarse", "registra't", "s'inscrire"],
  "log out": ["cerrar sesión", "tanca la sessió", "se déconnecter"],
  "add to cart": ["añadir al carrito", "afegeix al carretó", "ajouter au panier"],
  "free shipping": ["envío gratuito", "enviament gratuït", "livraison gratuite"],
  "out of stock": ["agotado", "esgotat", "en rupture de stock"],
  "customer service": ["atención al cliente", "atenció al client", "service client"],
  "credit card": ["tarjeta de crédito", "targeta de crèdit", "carte de crédit"],
  "terms of service": ["condiciones del servicio", "condicions del servei", "conditions d'utilisation"],
  "privacy policy": ["política de privacidad", "política de privacitat", "politique de confidentialité"],
  "forgot password": ["olvidé la contraseña", "he oblidat la contrasenya", "mot de passe oublié"],
  "contact us": ["contáctanos", "contacta'ns", "contactez-nous"],
  "learn more": ["más información", "més informació", "en savoir plus"],
  "try again": ["inténtalo de nuevo", "torna-ho a provar", "réessayer"],
  "see you soon": ["hasta pronto", "fins aviat", "à bientôt"],
};

const WORDS: Record<string, [string, string, string]> = {
  hello: ["hola", "hola", "bonjour"], goodbye: ["adiós", "adéu", "au revoir"], please: ["por favor", "si us plau", "s'il vous plaît"],
  yes: ["sí", "sí", "oui"], no: ["no", "no", "non"], the: ["el", "el", "le"], a: ["un", "un", "un"], and: ["y", "i", "et"],
  or: ["o", "o", "ou"], with: ["con", "amb", "avec"], without: ["sin", "sense", "sans"], for: ["para", "per a", "pour"],
  from: ["de", "de", "de"], to: ["a", "a", "à"], in: ["en", "a", "dans"], on: ["en", "a", "sur"], of: ["de", "de", "de"],
  is: ["es", "és", "est"], are: ["son", "són", "sont"], was: ["fue", "va ser", "était"], we: ["nosotros", "nosaltres", "nous"],
  you: ["tú", "tu", "vous"], i: ["yo", "jo", "je"], it: ["eso", "això", "cela"], they: ["ellos", "ells", "ils"],
  my: ["mi", "el meu", "mon"], your: ["tu", "el teu", "votre"], our: ["nuestro", "el nostre", "notre"],
  order: ["pedido", "comanda", "commande"], orders: ["pedidos", "comandes", "commandes"], price: ["precio", "preu", "prix"],
  prices: ["precios", "preus", "prix"], payment: ["pago", "pagament", "paiement"], invoice: ["factura", "factura", "facture"],
  account: ["cuenta", "compte", "compte"], password: ["contraseña", "contrasenya", "mot de passe"], email: ["correo", "correu", "e-mail"],
  shipping: ["envío", "enviament", "livraison"], delivery: ["entrega", "lliurament", "livraison"], product: ["producto", "producte", "produit"],
  products: ["productos", "productes", "produits"], cart: ["carrito", "carretó", "panier"], checkout: ["pago", "pagament", "paiement"],
  search: ["buscar", "cerca", "rechercher"], settings: ["ajustes", "configuració", "paramètres"], help: ["ayuda", "ajuda", "aide"],
  support: ["soporte", "suport", "assistance"], new: ["nuevo", "nou", "nouveau"], free: ["gratis", "gratuït", "gratuit"],
  today: ["hoy", "avui", "aujourd'hui"], tomorrow: ["mañana", "demà", "demain"], now: ["ahora", "ara", "maintenant"],
  day: ["día", "dia", "jour"], days: ["días", "dies", "jours"], week: ["semana", "setmana", "semaine"], month: ["mes", "mes", "mois"],
  year: ["año", "any", "an"], time: ["tiempo", "temps", "temps"], user: ["usuario", "usuari", "utilisateur"],
  users: ["usuarios", "usuaris", "utilisateurs"], agent: ["agente", "agent", "agent"], agents: ["agentes", "agents", "agents"],
  job: ["trabajo", "feina", "travail"], jobs: ["trabajos", "feines", "travaux"], money: ["dinero", "diners", "argent"],
  fast: ["rápido", "ràpid", "rapide"], secure: ["seguro", "segur", "sécurisé"], easy: ["fácil", "fàcil", "facile"],
  open: ["abrir", "obrir", "ouvrir"], close: ["cerrar", "tancar", "fermer"], save: ["guardar", "desar", "enregistrer"],
  delete: ["eliminar", "suprimir", "supprimer"], edit: ["editar", "editar", "modifier"], send: ["enviar", "enviar", "envoyer"],
  buy: ["comprar", "comprar", "acheter"], pay: ["pagar", "pagar", "payer"], cancel: ["cancelar", "cancel·lar", "annuler"],
  confirm: ["confirmar", "confirmar", "confirmer"], continue: ["continuar", "continuar", "continuer"], back: ["atrás", "enrere", "retour"],
  next: ["siguiente", "següent", "suivant"], error: ["error", "error", "erreur"], success: ["éxito", "èxit", "succès"],
  welcome: ["bienvenido", "benvingut", "bienvenue"], thanks: ["gracias", "gràcies", "merci"], team: ["equipo", "equip", "équipe"],
  company: ["empresa", "empresa", "entreprise"], service: ["servicio", "servei", "service"], services: ["servicios", "serveis", "services"],
  data: ["datos", "dades", "données"], file: ["archivo", "fitxer", "fichier"], files: ["archivos", "fitxers", "fichiers"],
  name: ["nombre", "nom", "nom"], address: ["dirección", "adreça", "adresse"], phone: ["teléfono", "telèfon", "téléphone"],
  country: ["país", "país", "pays"], city: ["ciudad", "ciutat", "ville"], total: ["total", "total", "total"], available: ["disponible", "disponible", "disponible"],
  status: ["estado", "estat", "statut"], pending: ["pendiente", "pendent", "en attente"], approved: ["aprobado", "aprovat", "approuvé"],
  rejected: ["rechazado", "rebutjat", "rejeté"], good: ["bueno", "bo", "bon"], bad: ["malo", "dolent", "mauvais"],
  big: ["grande", "gran", "grand"], small: ["pequeño", "petit", "petit"], more: ["más", "més", "plus"], less: ["menos", "menys", "moins"],
  here: ["aquí", "aquí", "ici"], there: ["allí", "allà", "là"], all: ["todo", "tot", "tout"]
};

const TARGET_INDEX: Record<Target, number> = { es: 0, ca: 1, fr: 2 };

function translate(source: string, target: Target): { translation: string; untranslated: string[]; coverage: number } {
  const index = TARGET_INDEX[target];
  let working = source;
  const placeholders: string[] = [];
  for (const [phrase, options] of Object.entries(PHRASES)) {
    const pattern = new RegExp(`\\b${phrase}\\b`, "gi");
    working = working.replace(pattern, (match) => {
      placeholders.push(matchCase(match, options[index] ?? match));
      return `\uE000${(placeholders.length - 1).toString()}\uE000`;
    });
  }
  const untranslated = new Set<string>();
  let known = 0;
  let total = 0;
  const translated = working.replace(/\uE000(\d+)\uE000|[A-Za-z']+/g, (match, slot?: string) => {
    if (slot !== undefined) {
      known += 1;
      total += 1;
      return placeholders[Number(slot)] ?? "";
    }
    total += 1;
    const entry = WORDS[match.toLowerCase()];
    const value = entry?.[index];
    if (value === undefined || value === "") {
      untranslated.add(match.toLowerCase());
      return match;
    }
    known += 1;
    return matchCase(match, value);
  });
  return {
    translation: clip(translated, 5000),
    untranslated: [...untranslated].slice(0, 100).map((word) => clip(word, 64)),
    coverage: total === 0 ? 1 : Math.round((known / total) * 1000) / 1000,
  };
}

function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  const first = original.charAt(0);
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const output = s.obj({
  translation: s.str(5000),
  untranslated: s.arr(s.str(64), 100),
  coverage: s.num(0, 1),
});

function glossaryTool(target: Target, language: string, slugSuffix: string, example: string): FleetTool {
  return {
    name: `Glossary translator English to ${language}`,
    slug: `translate_en_${slugSuffix}`,
    category: "translation",
    description:
      `Translate short English UI strings, product labels, e-commerce copy and support replies into ${language} using a ` +
      `curated glossary (phrase and word level). Reports untranslated words and coverage so a human can finish the job. ` +
      `Localization, i18n and multilingual support.`,
    tags: ["translation", "localization", "i18n", target, "multilingual"],
    priceUsdc: "0.015",
    p95Ms: 250,
    p50Ms: 60,
    input: { text: s.str(5000, 1) },
    required: ["text"],
    example: { text: example },
    output,
    run(input) {
      return translate(text(input, "text").slice(0, 5000), target);
    },
  };
}

export const translationTools: FleetTool[] = [
  glossaryTool("es", "Spanish", "es", "Thank you for your order. Free shipping today!"),
  glossaryTool("ca", "Catalan", "ca", "Welcome! Sign in to your account to see your orders."),
  glossaryTool("fr", "French", "fr", "Add to cart. Contact us for help with payment."),
];
