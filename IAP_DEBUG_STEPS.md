# IAP Purchase Error Debugging Steps

## Current Error
"Purchase error, undefined is not a function"

## What We Need

**Please check your console/terminal logs** when you try to purchase and share:

1. **What logs appear before the error?** Look for:
   - `🔍 Getting IAP module...`
   - `✅ IAP module loaded. Available methods: [...]`
   - `📦 IAP module loaded:` (with details)
   - `❌ IAP module missing [method name]`

2. **Which specific function is undefined?** The logs should show:
   - `❌ purchaseUpdatedListener is not a function` OR
   - `❌ purchaseErrorListener is not a function` OR
   - `❌ requestPurchase is not a function` OR
   - `❌ initConnection is not a function`

3. **What methods are available?** Look for:
   - `Available methods: [...]` or
   - `Available on iapModule: [...]`

## Quick Test

Try this in your app console (if you have access):

```javascript
// In the app, try to see what's available
import RNIap from 'react-native-iap';
console.log('RNIap:', RNIap);
console.log('Methods:', Object.keys(RNIap));
console.log('requestPurchase:', typeof RNIap.requestPurchase);
console.log('purchaseUpdatedListener:', typeof RNIap.purchaseUpdatedListener);
```

## Common Issues

1. **Module not properly linked** - May need to rebuild
2. **Wrong API usage** - react-native-iap v14 might have different method names
3. **Import structure** - The dynamic import might not be getting the right structure

## Next Steps

Once you share the console logs, I can:
1. Identify which exact function is undefined
2. Fix the import/usage pattern
3. Update the code accordingly

**Please share the console output when you try to purchase!**

