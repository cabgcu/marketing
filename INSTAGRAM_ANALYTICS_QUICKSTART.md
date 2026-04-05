# Instagram Analytics Dashboard - Quick Start Guide

## Get Started in 5 Minutes

### Step 1: Get Your Instagram Access Token (2 min)
1. Go to [Meta Developer Dashboard](https://developers.facebook.com)
2. Create an app (if you don't have one)
3. Add Instagram Graph API product
4. Get an access token for your Business Account
   - Go to Tools → Token Debugger
   - Or use Instagram Business Account token

### Step 2: Configure in App (1 min)
1. Open the task management app
2. Click ⚙️ **Settings** tab
3. Navigate to **Integrations** section
4. Paste your Instagram Access Token in the field
5. (Optional) Paste your Business Account ID
6. Click **Verify Token** button

### Step 3: View Analytics (1 min)
1. The **📊 Analytics** tab now appears in bottom navigation
2. Click **📊 Analytics**
3. Dashboard loads automatically
4. View your Instagram metrics!

### Step 4: Link Posts to Tasks (1 min)
1. Open any task (or create a new one)
2. Scroll down to **Instagram Post Link** section
3. Click **Link IG Post** button
4. Select a recent post from the picker modal
5. Post metrics display on your task
6. Save the task

---

## Features Overview

### 📊 Analytics Dashboard Shows:

**Account Stats**
- Total followers
- Follower growth (7 & 30 day trends)
- Total posts published
- Average engagement rate
- Account handle & name

**Recent Posts** (Last 12)
- Post thumbnail/preview
- Caption preview
- Likes, comments, saves, reach metrics
- Engagement rate percentage
- Posted date & time

**Best Times to Post**
- Top 5 optimal posting times
- Day of week + hour analyzed
- Number of posts at that time
- Average engagement for that time slot

### 🔗 Link Instagram Posts to Tasks

Link any Instagram post to a task to:
- Track post performance with the event
- View engagement metrics on task card
- Monitor campaign metrics in one place
- Correlate task completion with post performance

---

## Common Tasks

### How to Refresh Metrics?
1. Open Analytics dashboard
2. Click **🔄 Refresh** button
3. Metrics update in real-time

### How to Find Best Times to Post?
1. Open Analytics
2. Scroll to **Best Times to Post** section
3. Look for 🏆 symbol (top ranked)
4. Plan future posts for those times

### How to Link Multiple Posts to One Task?
1. Open task
2. In "Instagram Post Link" section
3. Enter first post ID
4. Link it
5. (Note: Currently supports one post per task - copy task for multiple posts)

### How to Remove a Linked Post?
1. Open task
2. Clear the Post ID field
3. Save task
4. Post link removed

### What if My Token Expires?
1. Go to Settings > Integrations
2. Generate new token from Meta Developer Dashboard
3. Paste new token
4. Click Verify Token
5. Dashboard continues working

---

## Troubleshooting

**"Instagram Analytics Not Configured"**
- You haven't set your access token yet
- Go to Settings > Integrations and add it

**"Error Loading Analytics"**
- Token might be expired or invalid
- Try: Settings > Integrations > Verify Token
- Or re-generate token in Meta Developer Dashboard

**"No posts showing"**
- Business Account needs at least one post
- Publish a post first, then refresh
- Or ensure token has permission to access posts

**"Post metrics showing as zero"**
- Instagram needs 24 hours to collect insights
- Wait a day after publishing
- Then refresh the dashboard

---

## Tips & Best Practices

✅ **DO:**
- Check best times to post before publishing
- Link important posts to marketing tasks
- Refresh analytics daily
- Monitor engagement trends
- Use insights to improve content strategy

❌ **DON'T:**
- Share your access token publicly
- Use personal account tokens (use Business Account)
- Expect real-time metrics (24-hour delay)
- Refresh too frequently (risk rate limiting)

---

## API Rate Limits

Instagram allows **200 API calls per user per hour**

The app is efficient:
- Batches requests
- Caches data
- Only fetches needed metrics

You can safely:
- View analytics multiple times
- Refresh 5-10 times per hour
- Link posts frequently

---

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open Analytics | Click 📊 tab |
| Open Task | Click any card |
| Close Modal | Press Esc |
| Save Task | Click "Save Task" or Ctrl+S |

---

## What's Next?

1. **Explore Your Data**: Spend time understanding your metrics
2. **Find Patterns**: Notice posting times and engagement trends
3. **Optimize**: Schedule posts for your best times
4. **Track**: Link posts to tasks and monitor performance
5. **Improve**: Use insights to create better content

---

## Need Help?

- **API Issues**: Check [Instagram Graph API Docs](https://developers.facebook.com/docs/instagram-api)
- **Token Problems**: Visit [Meta Developer Dashboard](https://developers.facebook.com)
- **App Issues**: Check the implementation guide or contact support

---

**Happy analyzing! 🚀**
