import * as readline from 'readline';
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const {LoginSession, EAuthTokenPlatformType} = require('steam-session');


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

async function main() {
  const username = await question('Steam username: ');
  const password = await question('Steam password: ');
  const sharedSecret = await question('Shared secret (for 2FA, leave empty if none): ');
  const appidStr = await question('App ID (e.g., 730 for CS:GO): ');
  const contextidStr = await question('Context ID (e.g., 2 for CS:GO): ');

  const appid = parseInt(appidStr);
  const contextid = parseInt(contextidStr);

  const community = new (SteamCommunity as any)();

  // Use steam-session for login to handle mobile confirmation
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

  session.on('authenticated', async () => {
    try {
      const webCookies = await session.getWebCookies();
      const cookiesStr = webCookies.join('; ');
      console.log('Logged in successfully');

      // Get steamid
      const profileResponse = await fetch('https://steamcommunity.com/my/profile', {
        headers: {
          'Cookie': cookiesStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        redirect: 'manual'
      });
      const location = profileResponse.headers.get('location');
      if (!location) {
        throw new Error('Failed to get steamid');
      }
      const steamId = location.split('/')[4];

      // Get inventory
      const inventoryUrl = `https://steamcommunity.com/inventory/${steamId}/${appid}/${contextid}?l=english`;
      const inventoryResponse = await fetch(inventoryUrl, {
        headers: {
          'Cookie': cookiesStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      if (!inventoryResponse.ok) {
        throw new Error(`Failed to get inventory: ${inventoryResponse.status}`);
      }
      const inventoryData = await inventoryResponse.json() as any;
      const assets = inventoryData.assets || [];
      const descriptions = inventoryData.descriptions || [];
      const descMap = new Map<string, any>();
      for (const desc of descriptions) {
        const key = `${desc.classid}_${desc.instanceid}`;
        descMap.set(key, desc);
      }
      const marketableItems: any[] = [];
      for (const asset of assets) {
        const key = `${asset.classid}_${asset.instanceid}`;
        const desc = descMap.get(key);
        if (desc && desc.marketable && desc.market_hash_name) {
          marketableItems.push({ ...asset, market_hash_name: desc.market_hash_name });
        }
      }
      console.log(`Found ${assets.length} items in inventory, ${marketableItems.length} marketable`);

      // Sell each item
      await sellItems(webCookies, marketableItems, appid, steamId);
      console.log('Finished selling');
      rl.close();
    } catch (ex) {
      console.error('Error after authentication:', ex);
      rl.close();
    }
  });

  session.on('error', (err: any) => {
    console.error('Login failed:', err);
    rl.close();
  });

  try {
    let startResult = await session.startWithCredentials({
      accountName: username,
      password: password,
      steamGuardCode: sharedSecret ? SteamTotp.generateAuthCode(sharedSecret) : undefined
    });

    if (startResult.actionRequired) {
      console.log('Mobile confirmation required. Please check your Steam mobile app and approve the login.');
      // Do not cancel, wait for authenticated event
    }
  } catch (ex: any) {
    if (ex.code === 429) {
      console.log('Rate limited by Steam. Waiting 30 seconds before retrying...');
      await delay(30000);
      try {
        const startResult = await session.startWithCredentials({
          accountName: username,
          password: password,
          steamGuardCode: sharedSecret ? SteamTotp.generateAuthCode(sharedSecret) : undefined
        });
        if (startResult.actionRequired) {
          console.log('Mobile confirmation required. Please check your Steam mobile app and approve the login.');
        }
      } catch (retryEx) {
        console.error('Failed to start login after retry:', retryEx);
        rl.close();
        return;
      }
    } else {
      console.error('Failed to start login:', ex);
      rl.close();
      return;
    }
  }
}

async function sellItems(cookies: string[], items: any[], appid: number, steamId: string) {
  const cookiesStr = cookies.join('; ');
  for (const item of items) {
    try {
      const price = await getRecommendedPrice(cookiesStr, appid, item.market_hash_name);
      if (price) {
        await sellItem(cookiesStr, item, price, appid, steamId);
        console.log(`Sold ${item.market_hash_name} for ${price} cents`);
        // Delay to avoid rate limits
        await delay(2000);
      } else {
        console.log(`No price found for ${item.market_hash_name}`);
      }
    } catch (error) {
      console.error(`Failed to sell ${item.market_hash_name}:`, error);
    }
  }
}

async function getRecommendedPrice(cookiesStr: string, appid: number, marketHashName: string): Promise<number | null> {
  const priceUrl = `https://steamcommunity.com/market/priceoverview/?appid=${appid}&market_hash_name=${encodeURIComponent(marketHashName)}&currency=1`;
  const response = await fetch(priceUrl, {
    headers: {
      'Cookie': cookiesStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json() as any;
  if (data.success && data.lowest_price) {
    const priceStr = data.lowest_price.replace('$', '');
    return priceStr;
  }
  return null;
}

async function sellItem(cookiesStr: string, item: any, price: number, appid: number, steamId: string): Promise<void> {
    console.log(`Selling item ${item.market_hash_name} at price ${price} cents`);
  const sellUrl = 'https://steamcommunity.com/market/sellitem/';
  const formData = new URLSearchParams();
  formData.append('sessionid', cookiesStr.match(/sessionid=([^;]+)/)?.[1] || '');
  formData.append('appid', item.appid.toString());
  formData.append('contextid', item.contextid.toString());
  formData.append('assetid', item.assetid || item.id);
  formData.append('amount', '1');
  formData.append('price', price.toString());

  const response = await fetch(sellUrl, {
    method: 'POST',
    headers: {
      'Cookie': cookiesStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://steamcommunity.com/market/',
      'Origin': 'https://steamcommunity.com'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    throw new Error(`Sell failed: ${response.status}`);
  }

  const data = await response.json() as any;
  if (!data.success) {
    throw new Error(`Sell failed: ${data.message || 'Unknown error'}`);
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();