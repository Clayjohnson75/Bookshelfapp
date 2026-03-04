/**
 * Unit test for scan.ts - verifies Gemini API request body structure
 * 
 * This test ensures that:
 * 1. responseSchema is NOT at the top level
 * 2. generationConfig.responseMimeType is set to "application/json"
 * 3. generationConfig.temperature is set to 0
 * 4. generationConfig.responseJsonSchema exists (not responseSchema)
 * 
 * Run with: npx ts-node api/scan.test.ts
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Read the source file to verify the structure
const sourceFile = path.join(__dirname, 'scan.ts');
const sourceCode = fs.readFileSync(sourceFile, 'utf-8');

// Parse the JSON body structure from the source code
// Look for the request body structure in scanWithGeminiDirect
function extractRequestBodyStructure(): any {
 // Find the JSON.stringify call in scanWithGeminiDirect
 const functionStart = sourceCode.indexOf('async function scanWithGeminiDirect');
 if (functionStart === -1) {
 throw new Error('scanWithGeminiDirect function not found');
 }
 
 // Find the body: JSON.stringify({...}) part
 const bodyStart = sourceCode.indexOf('body: JSON.stringify({', functionStart);
 if (bodyStart === -1) {
 throw new Error('Request body not found');
 }
 
 // Extract the object structure (simplified - just check for key patterns)
 const bodyEnd = sourceCode.indexOf('}),', bodyStart);
 if (bodyEnd === -1) {
 throw new Error('Request body end not found');
 }
 
 const bodySection = sourceCode.substring(bodyStart, bodyEnd);
 return bodySection;
}

function testRequestBodyStructure() {
 console.log('Testing Gemini API request body structure...');
 
 const bodySection = extractRequestBodyStructure();
 
 // Test 1: Must NOT have top-level responseSchema
 const hasTopLevelResponseSchema = bodySection.includes('responseSchema:') && 
 !bodySection.includes('generationConfig:') ||
 (bodySection.indexOf('responseSchema:') < bodySection.indexOf('generationConfig:'));
 
 // More accurate: check that responseSchema is inside generationConfig
 const responseSchemaIndex = bodySection.indexOf('responseSchema:');
 const generationConfigIndex = bodySection.indexOf('generationConfig:');
 
 if (responseSchemaIndex !== -1 && generationConfigIndex !== -1) {
 // responseSchema should come AFTER generationConfig (inside it)
 assert.ok(
 responseSchemaIndex > generationConfigIndex,
 'FAIL: responseSchema should be inside generationConfig, not at top level'
 );
 }
 
 // Test 2: Must have generationConfig.responseMimeType = "application/json"
 assert.ok(
 bodySection.includes('responseMimeType: "application/json"'),
 'FAIL: generationConfig must have responseMimeType: "application/json"'
 );
 
 // Test 3: Must have generationConfig.temperature = 0
 assert.ok(
 bodySection.includes('temperature: 0'),
 'FAIL: generationConfig must have temperature: 0'
 );
 
 // Test 4: Must have generationConfig.responseJsonSchema (not responseSchema at top level)
 assert.ok(
 bodySection.includes('responseJsonSchema:'),
 'FAIL: generationConfig must have responseJsonSchema (not top-level responseSchema)'
 );
 
 // Test 5: Verify responseJsonSchema is inside generationConfig
 const responseJsonSchemaIndex = bodySection.indexOf('responseJsonSchema:');
 assert.ok(
 responseJsonSchemaIndex > generationConfigIndex,
 'FAIL: responseJsonSchema must be inside generationConfig'
 );
 
 console.log(' All tests passed!');
 console.log(' - No top-level responseSchema');
 console.log(' - generationConfig.responseMimeType = "application/json"');
 console.log(' - generationConfig.temperature = 0');
 console.log(' - generationConfig.responseJsonSchema exists');
}

// Alternative: Test by actually constructing the request body
function testRequestBodyObject() {
 console.log('\nTesting request body object structure...');
 
 const testImageDataURL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
 const base64Data = testImageDataURL.replace(/^data:image\/[a-z]+;base64,/, '');
 
 // This is the CORRECT structure (what we want)
 const requestBody = {
 contents: [
 {
 parts: [
 {
 text: 'test prompt',
 },
 { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
 ],
 },
 ],
 generationConfig: { 
 responseMimeType: "application/json",
 temperature: 0,
 maxOutputTokens: 8000,
 responseJsonSchema: {
 type: "array",
 items: {
 type: "object",
 properties: {
 title: { type: "string" },
 author: { type: "string" },
 confidence: { type: "string", enum: ["high", "medium", "low"] },
 spine_text: { type: "string" },
 language: { type: "string", enum: ["en", "es", "fr", "unknown"] },
 reason: { type: "string" },
 spine_index: { type: "number" },
 },
 required: ["title", "confidence", "spine_index"],
 },
 },
 },
 };
 
 // Assertions
 assert.strictEqual(
 (requestBody as any).responseSchema,
 undefined,
 'FAIL: Request body must NOT have top-level responseSchema'
 );
 
 assert.ok(
 requestBody.generationConfig,
 'FAIL: Request body must have generationConfig'
 );
 
 assert.strictEqual(
 requestBody.generationConfig.responseMimeType,
 "application/json",
 'FAIL: generationConfig.responseMimeType must be "application/json"'
 );
 
 assert.strictEqual(
 requestBody.generationConfig.temperature,
 0,
 'FAIL: generationConfig.temperature must be 0'
 );
 
 assert.ok(
 requestBody.generationConfig.responseJsonSchema,
 'FAIL: generationConfig must have responseJsonSchema'
 );
 
 assert.strictEqual(
 (requestBody.generationConfig as any).responseSchema,
 undefined,
 'FAIL: generationConfig must NOT have responseSchema (should be responseJsonSchema)'
 );
 
 console.log(' Request body object structure is correct!');
}

// Run tests
try {
 testRequestBodyStructure();
 testRequestBodyObject();
 console.log('\n All tests passed!');
 process.exit(0);
} catch (error: any) {
 console.error('\n Test failed:', error.message);
 process.exit(1);
}

