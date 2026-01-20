import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { firstName } = req.body;

  if (!firstName || typeof firstName !== 'string') {
    return res.status(400).json({ error: 'First name is required' });
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  try {
    // Create prompt for DALL-E - ONLY TEXT, book-themed typography, HUGE text
    // Note: DALL-E struggles with exact text spelling, so we emphasize it heavily
    const prompt = `Profile picture: ONLY the exact text "${firstName}" in enormous bold letters filling 95% of the square image. The letters are styled with a book theme - each letter looks like a book or has book-like texture. Zero decorations. Zero icons. Zero background elements. Zero borders. Pure text only. The spelling must be exactly "${firstName}". The text is the only thing visible in the entire image.`;

    // Call DALL-E API
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json', // Return base64 for easier storage
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('DALL-E API error:', error);
      return res.status(response.status).json({ 
        error: 'Failed to generate avatar',
        details: error 
      });
    }

    const data = await response.json() as { data?: Array<{ b64_json?: string }> };
    const imageBase64 = data.data?.[0]?.b64_json;

    if (!imageBase64) {
      return res.status(500).json({ 
        error: 'No image data received from OpenAI',
        details: 'OpenAI did not return image data'
      });
    }

    // Return the base64 image
    return res.status(200).json({
      success: true,
      imageData: `data:image/png;base64,${imageBase64}`,
    });

  } catch (error: any) {
    console.error('Avatar generation error:', error);
    return res.status(500).json({
      error: 'Failed to generate avatar',
      details: error.message,
    });
  }
}

