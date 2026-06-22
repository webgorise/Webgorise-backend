const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Areas and business types to search
const SEARCH_AREAS = [
  "Waller TX",
  "Katy TX",
  "Houston TX",
  "Brookshire TX",
  "Hempstead TX",
  "Cypress TX",
  "Spring TX",
  "Tomball TX",
  "Humble TX",
  "Baytown TX",
];

const BUSINESS_TYPES = [
  "restaurant",
  "bakery",
  "auto repair",
  "hair salon",
  "barbershop",
  "dentist",
  "florist",
  "gym",
  "pet grooming",
  "landscaping",
  "plumber",
  "electrician",
  "nail salon",
  "coffee shop",
  "hardware store",
  "pharmacy",
  "clothing store",
  "real estate",
  "insurance",
  "accountant",
];

// Pick random item from array
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Check if a website is weak/missing
async function checkWebsite(websiteUrl) {
  if (!websiteUrl) return { hasWebsite: false, issue: "No website found" };
  
  try {
    const res = await axios.get(websiteUrl, { timeout: 5000 });
    const html = res.data.toLowerCase();
    
    const issues = [];
    if (!html.includes("viewport")) issues.push("Not mobile-friendly");
    if (html.length < 3000) issues.push("Very thin content — poor SEO");
    if (!html.includes("contact") && !html.includes("phone")) issues.push("No contact info visible");
    
    if (issues.length > 0) return { hasWebsite: true, issue: issues[0] };
    return { hasWebsite: true, issue: "Site looks basic — could be modernized" };
  } catch {
    return { hasWebsite: true, issue: "Site loads slowly or has errors" };
  }
}

// Use Claude AI to write a personalized outreach message
async function generateOutreachMessage(business, websiteIssue) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Write a short, friendly, conversational SMS outreach message for a web design agency called WebGoRise reaching out to this local business:

Business name: ${business.name}
Type: ${business.type}
Location: ${business.location}
Website issue: ${websiteIssue}

Rules:
- Max 3 sentences
- Sound human, not salesy
- Mention their specific website problem naturally
- Mention plans start at $300/mo
- End with a simple question to get a reply
- End with: "Reply STOP to opt out."
- Do NOT use emojis
- Output only the message text, nothing else`
        }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        }
      }
    );
    return response.data.content[0].text.trim();
  } catch {
    return `Hi! I came across ${business.name} and noticed ${websiteIssue.toLowerCase()}. I help local businesses like yours get a fast, modern website starting at $300/mo — no contracts. Want to see a free preview of what we'd build for you? Reply STOP to opt out.`;
  }
}

// Main function: find a batch of real leads
async function findRealLeads(count = 5) {
  const leads = [];
  const seen = new Set();

  for (let i = 0; i < count * 3 && leads.length < count; i++) {
    const area = pick(SEARCH_AREAS);
    const type = pick(BUSINESS_TYPES);
    const query = `${type} in ${area}`;

    try {
      // Search Google Places
      const searchRes = await axios.get(
        `https://maps.googleapis.com/maps/api/place/textsearch/json`,
        {
          params: { query, key: GOOGLE_API_KEY },
          timeout: 8000,
        }
      );

      const places = searchRes.data.results || [];

      for (const place of places) {
        if (leads.length >= count) break;
        if (seen.has(place.place_id)) continue;
        seen.add(place.place_id);

        // Get full details including phone + website
        const detailRes = await axios.get(
          `https://maps.googleapis.com/maps/api/place/details/json`,
          {
            params: {
              place_id: place.place_id,
              fields: "name,formatted_phone_number,website,formatted_address,types,rating",
              key: GOOGLE_API_KEY,
            },
            timeout: 8000,
          }
        );

        const details = detailRes.data.result || {};
        if (!details.formatted_phone_number) continue; // skip if no phone

        // Check their website quality
        const { hasWebsite, issue } = await checkWebsite(details.website);

        // Score based on how weak their web presence is
        const score = !hasWebsite ? 95 :
          issue.includes("mobile") ? 88 :
          issue.includes("slow") ? 82 : 76;

        // Suggest a plan based on business type
        const premiumTypes = ["dentist", "real estate", "accountant", "insurance"];
        const growthTypes = ["restaurant", "gym", "auto repair", "pharmacy"];
        const plan = premiumTypes.some(t => type.includes(t)) ? "Premium" :
          growthTypes.some(t => type.includes(t)) ? "Growth" : "Starter";

        // Generate AI outreach message
        const business = {
          name: details.name,
          type: type.charAt(0).toUpperCase() + type.slice(1),
          location: area,
        };
        const draft = await generateOutreachMessage(business, issue);

        leads.push({
          id: Date.now() + Math.random(),
          name: details.name,
          type: business.type,
          location: area,
          phone: details.formatted_phone_number,
          websiteIssue: issue,
          hasWebsite,
          rating: details.rating || null,
          plan,
          score,
          draft,
          foundVia: `Google Maps: ${query}`,
        });

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err) {
      console.error(`Search failed for "${query}":`, err.message);
    }
  }

  return leads;
}

// ─── ROUTES ───────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "WebGoRise backend running ✓" });
});

// Get a fresh batch of real leads for the Approve Queue
app.get("/leads", async (req, res) => {
  const count = parseInt(req.query.count) || 5;
  try {
    const leads = await findRealLeads(Math.min(count, 10));
    res.json({ success: true, leads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate an outreach message for a specific business
app.post("/generate-message", async (req, res) => {
  const { business, websiteIssue } = req.body;
  try {
    const message = await generateOutreachMessage(business, websiteIssue);
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`WebGoRise backend running on port ${PORT}`));
