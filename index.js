require("dotenv").config();
const { HfInference } = require("@huggingface/inference");
const hf = new HfInference(process.env.HF_API_KEY);
const axios = require("axios");
const cheerio = require("cheerio");

function isValidBlogLink(url) {
  return (
    !url.includes("wikipedia.org") &&
    !url.includes("beyondchats.com") &&
    !url.includes("youtube.com") &&
    !url.includes("facebook.com") &&
    !url.includes("linkedin.com")
  );
}

/**
 * 1️⃣ Fetch latest article from Laravel
 */
async function fetchLatestArticle() {
  const res = await axios.get(
    `${process.env.LARAVEL_API}/articles-latest`
  );
  return res.data;
}

/**
 * 2️⃣ Search Google using Serper.dev API and extract first 2 blog/article links
 */
async function googleSearch(title) {
  try {
    const res = await axios.post(
      "https://google.serper.dev/search",
      { q: title },
      {
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const links = res.data.organic
      .map(r => r.link)
      .filter(isValidBlogLink)
      .slice(0, 2);

    return links;
  } catch (err) {
    console.error("Google search failed:", err.message);
    return [];
  }
}

/**
 * 3️⃣ Scrape main article content
 */
async function scrapeArticle(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);

    const text =
      $("article").text() ||
      $("main").text() ||
      $("body").text();

    return text.replace(/\s+/g, " ").trim().slice(0, 4000);
  } catch (err) {
    console.error("Scrape failed:", url);
    return "";
  }
}

async function rewriteWithAI(original, refs, urls) {
  const model = "meta-llama/Llama-3.2-3B-Instruct";

  try {
    const response = await hf.chatCompletion({
      model: model,
      messages: [
        {
          role: "system",
          content: "You are an SEO Expert. Return your response in this exact format:\nTITLE: [New Unique Related Title]\nDESCRIPTION: [New SEO Description]\nCONTENT: [The HTML Article]"
        },
        {
          role: "user",
          content: `Rewrite this: ${original.slice(0, 800)}. Refs: ${urls.join(", ")}`
        }
      ],
      max_tokens: 1500,
    });

    const text = response.choices[0].message.content;

    // Pulling the pieces out of the AI response
    const title = text.match(/TITLE:\s*(.*)/i)?.[1] || "New Efficiency Insights";
    const description = text.match(/DESCRIPTION:\s*(.*)/i)?.[1] || "Learn how to optimize service platforms.";
    const content = text.match(/CONTENT:\s*([\s\S]*)/i)?.[1] || text;

    return { title, description, content };
  } catch (err) {
    console.error(`❌ LLM Error:`, err.message);
    return null;
  }
}

/**
 * 5️⃣ Save AI article back to Laravel
 */
/**
 * 5️⃣ Enhanced Save function to extract metadata from HTML
 */
async function publishArticle(id, aiData, refs) {
  // If aiData is just a string (content), we need to extract Title and Description
  let finalContent = typeof aiData === 'string' ? aiData : aiData.content;
  
  // 1. Extract Title: Find text inside the first <h2> or <h1>
  const titleMatch = finalContent.match(/<h[1-2][^>]*>([\s\S]*?)<\/h[1-2]>/i);
  const extractedTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : null;

  // 2. Extract Description: Find text inside the first <p>
  const descMatch = finalContent.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const extractedDesc = descMatch ? descMatch[1].replace(/<[^>]*>/g, "").trim() : null;

  console.log(`🏷️ Extracted Title: ${extractedTitle}`);
  console.log(`📝 Extracted Description: ${extractedDesc}`);

  // 3. Send to Laravel
  await axios.post(
    `${process.env.LARAVEL_API}/articles/${id}/ai-version`,
    { 
      // Mapping the extracted text to the specific DB columns
      title: extractedTitle, 
      description: extractedDesc,
      content: finalContent, 
      references: refs // Send as raw array to fix the \/ slash issue
    }
  );
}

/**
 * 6️⃣ MAIN WORKFLOW (Fixed logic)
 */
(async function main() {
  try {
    console.log("📥 Fetching latest article...");
    const article = await fetchLatestArticle();

    console.log("🔍 Searching Google...");
    const links = await googleSearch(article.title);

    if (links.length < 2) return console.error("❌ Not enough links.");

    console.log("📄 Scraping reference articles...");
    const refContents = await Promise.all(links.map(scrapeArticle));

    console.log("🤖 Generating AI article...");
    // FIX: Only call this ONCE and store in 'aiData'
    const aiData = await rewriteWithAI(article.content, refContents, links);

    if (!aiData || !aiData.content) {
      console.error("❌ AI Content generation failed.");
      return; 
    }

    console.log(`📤 Publishing: "${aiData.title}"`);
    
    // Pass the aiData object which has the NEW title and NEW description
    await publishArticle(article.id, aiData, links);

    console.log("✅ AI article published successfully!");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
  }
})();