# Instagram Analytics API Reference

## Function Reference

### Core Analytics Functions

#### `renderAnalytics()`
Main dashboard rendering function. Checks for token and loads all analytics data.

```javascript
async function renderAnalytics()
```

**Parameters**: None

**Returns**: Promise (void)

**Usage**:
```javascript
// Called when Analytics tab is clicked
await renderAnalytics();
```

**Behavior**:
- Checks if Instagram token is configured
- Shows config message if token missing
- Displays loading state
- Calls loadAnalyticsData()

---

#### `loadAnalyticsData(token)`
Fetches all analytics data from Instagram API.

```javascript
async function loadAnalyticsData(token)
```

**Parameters**:
- `token` (string): Instagram access token

**Returns**: Promise (void)

**Usage**:
```javascript
const token = appData.settings.instagramAccessToken;
await loadAnalyticsData(token);
```

**Error Handling**:
- Catches API errors
- Shows error message to user
- Displays retry option

---

#### `renderAnalyticsDashboard(accountData, mediaData, bestTimes)`
Renders the complete dashboard UI with all sections.

```javascript
function renderAnalyticsDashboard(accountData, mediaData, bestTimes)
```

**Parameters**:
- `accountData` (object): Account info from Instagram API
  ```javascript
  {
    id: "123456789",
    username: "myaccount",
    name: "My Business",
    biography: "...",
    followers_count: 5000,
    media_count: 150
  }
  ```
- `mediaData` (array): Array of media objects
- `bestTimes` (array): Analyzed posting times

**Returns**: void

**Renders**:
1. Account overview cards
2. Recent posts grid
3. Best times table

---

### API Data Fetching Functions

#### `fetchInstagramAccountInfo(accountId, token)`
Fetches business account information.

```javascript
async function fetchInstagramAccountInfo(accountId, token)
```

**Parameters**:
- `accountId` (string): Instagram Business Account ID
- `token` (string): Access token

**Returns**: Promise<object>

**Response**:
```javascript
{
  id: "123456789",
  username: "@myaccount",
  name: "My Business Name",
  biography: "Account bio text",
  followers_count: 5000,
  media_count: 150
}
```

**API Endpoint**:
```
GET https://graph.instagram.com/{accountId}
    ?fields=id,username,name,biography,followers_count,media_count
    &access_token={token}
```

**Errors**:
- 400: Invalid account ID
- 401: Invalid or expired token
- 429: Rate limit exceeded

---

#### `fetchInstagramMedia(accountId, token)`
Fetches recent media posts with insights.

```javascript
async function fetchInstagramMedia(accountId, token)
```

**Parameters**:
- `accountId` (string): Instagram Business Account ID
- `token` (string): Access token

**Returns**: Promise<array>

**Response Array Item**:
```javascript
{
  id: "17882028456123456",
  caption: "Post caption text",
  media_type: "IMAGE|VIDEO|CAROUSEL",
  media_url: "https://...",
  timestamp: "2024-04-05T14:30:00+0000",
  permalink: "https://instagram.com/p/...",
  insights: {
    data: [
      { name: "engagement", values: [{ value: 150 }] },
      { name: "impressions", values: [{ value: 3000 }] },
      { name: "reach", values: [{ value: 2500 }] },
      { name: "saves", values: [{ value: 75 }] }
    ]
  }
}
```

**API Endpoint**:
```
GET https://graph.instagram.com/{accountId}/media
    ?fields=id,caption,media_type,media_url,timestamp,permalink,
            insights.metric(engagement,impressions,reach,saves,video_views)
    &access_token={token}
```

**Pagination**: Returns up to 25 posts per request

---

### Analysis Functions

#### `analyzeBestPostingTimes(mediaData, token)`
Analyzes posting patterns from last 60 days.

```javascript
async function analyzeBestPostingTimes(mediaData, token)
```

**Parameters**:
- `mediaData` (array): Media array from fetchInstagramMedia
- `token` (string): Access token (for future enhancements)

**Returns**: Promise<array>

**Response** (top 5 slots):
```javascript
[
  {
    dayName: "Tuesday",
    hour: 7,
    date: Date,
    count: 3,
    totalEngagement: 450,
    avgEngagement: 150
  },
  // ... up to 5 items
]
```

**Algorithm**:
1. Filter posts from last 60 days
2. Group by day of week + hour
3. Calculate average engagement per slot
4. Sort by engagement descending
5. Return top 5

**Engagement Calculation**:
```
engagement = sum(likes + comments + shares)
avgEngagement = totalEngagement / postCount
```

---

#### `calculateFollowerGrowth(mediaData, days)`
Calculates follower growth over specified period.

```javascript
function calculateFollowerGrowth(mediaData, days)
```

**Parameters**:
- `mediaData` (array): Media data
- `days` (number): 7, 30, or custom days

**Returns**: number (follower count change)

**Note**: Requires historical data stored in settings

---

#### `calculateAverageEngagement(mediaData)`
Calculates average engagement rate across all posts.

```javascript
function calculateAverageEngagement(mediaData)
```

**Parameters**:
- `mediaData` (array): Media array

**Returns**: number (percentage 0-100)

**Formula**:
```
avgEngagement = (sum of all post engagements) / postCount
```

---

#### `calculatePostEngagement(media)`
Calculates engagement rate for single post.

```javascript
function calculatePostEngagement(media)
```

**Parameters**:
- `media` (object): Single media object

**Returns**: number (percentage)

**Formula**:
```
engagement% = (likes + comments + shares) / reach × 100
```

---

### Task Integration Functions

#### `linkInstagramPost()`
Links an Instagram post ID to the current task.

```javascript
function linkInstagramPost()
```

**Parameters**: None (reads from DOM)

**Returns**: void

**Behavior**:
1. Gets post ID from input field `#taskInstagramPostId`
2. Validates post ID exists
3. Updates currentEditingTask object
4. Triggers auto-save
5. Displays post metrics

**Error Handling**:
- Validates post ID not empty
- Shows toast notification on success

---

#### `displayInstagramPostMetrics(postId)`
Fetches and displays metrics for a linked post.

```javascript
function displayInstagramPostMetrics(postId)
```

**Parameters**:
- `postId` (string): Instagram post ID

**Returns**: void (async, updates DOM)

**Displays**:
- Engagement count
- Impressions
- Reach count
- Saves count

**Error Handling**: Falls back to generic message if fetch fails

---

#### `openInstagramPostPicker()`
Opens modal to select from recent posts.

```javascript
function openInstagramPostPicker()
```

**Parameters**: None

**Returns**: void

**Behavior**:
1. Creates/finds picker modal
2. Fetches last 20 posts
3. Displays as clickable grid
4. Waits for selection

**Modal Features**:
- Grid layout of thumbnails
- Media type indicators (🎥 or 📸)
- Click to select
- Auto-closes on selection

---

#### `selectInstagramPost(postId, caption)`
Callback when user selects post from picker.

```javascript
function selectInstagramPost(postId, caption)
```

**Parameters**:
- `postId` (string): Selected post ID
- `caption` (string): Post caption text

**Returns**: void

**Behavior**:
1. Sets post ID in input field
2. Calls linkInstagramPost()
3. Closes picker modal

---

### Utility Functions

#### `getMetricValue(media, metricName, defaultVal)`
Extracts metric from insights array.

```javascript
function getMetricValue(media, metricName, defaultVal = 0)
```

**Parameters**:
- `media` (object): Media object
- `metricName` (string): 'engagement', 'likes', 'reach', etc.
- `defaultVal` (number): Default if not found

**Returns**: number

**Example**:
```javascript
const likes = getMetricValue(post, 'likes', 0); // 150
const reach = getMetricValue(post, 'reach', 1); // 2500
```

---

#### `formatNumber(num)`
Formats numbers with K/M suffixes.

```javascript
function formatNumber(num)
```

**Parameters**:
- `num` (number): Number to format

**Returns**: string

**Examples**:
```javascript
formatNumber(1500)      // "1.5K"
formatNumber(5000000)   // "5.0M"
formatNumber(500)       // "500"
```

---

#### `renderPostsGrid(mediaData)`
Generates HTML for posts grid.

```javascript
function renderPostsGrid(mediaData)
```

**Parameters**:
- `mediaData` (array): Array of media objects

**Returns**: string (HTML)

**Renders**:
- Post thumbnail
- Caption preview
- Metrics badges
- Engagement percentage
- Posted timestamp

---

#### `renderBestTimesTable(bestTimes)`
Generates HTML for best times table.

```javascript
function renderBestTimesTable(bestTimes)
```

**Parameters**:
- `bestTimes` (array): Analyzed time slots

**Returns**: string (HTML)

**Features**:
- Rank with trophy icon for #1
- Day and hour columns
- Post count
- Engagement percentage
- Hover effects

---

#### `updateAnalyticsTabVisibility()`
Shows/hides analytics tab based on token.

```javascript
function updateAnalyticsTabVisibility()
```

**Parameters**: None

**Returns**: void

**Logic**:
- If token exists → tab visible
- If token missing → tab hidden

---

#### `refreshAnalytics()`
Manually refresh all analytics data.

```javascript
async function refreshAnalytics()
```

**Parameters**: None

**Returns**: Promise (void)

**Behavior**:
1. Disables refresh button
2. Shows loading state
3. Calls renderAnalytics()
4. Shows success toast
5. Re-enables button

---

## Data Structures

### Instagram Account Object
```javascript
{
  id: "123456789",
  username: "@myaccount",
  name: "My Business Name",
  biography: "Account bio",
  followers_count: 5000,
  media_count: 150,
  website: "https://example.com"
}
```

### Instagram Media Object
```javascript
{
  id: "17882028456123456",
  caption: "Post caption text",
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL",
  media_url: "https://cdn.instagram.com/...",
  timestamp: "2024-04-05T14:30:00+0000",
  permalink: "https://instagram.com/p/xyz/",
  insights: {
    data: [
      {
        name: "engagement",
        values: [{ value: 150 }],
        title: "Engagement",
        description: "Sum of comments, likes and shares"
      },
      {
        name: "impressions",
        values: [{ value: 3000 }]
      },
      {
        name: "reach",
        values: [{ value: 2500 }]
      },
      {
        name: "saves",
        values: [{ value: 75 }]
      }
    ]
  }
}
```

### Best Time Slot Object
```javascript
{
  dayName: "Tuesday",
  hour: 7,
  date: Date,
  count: 3,
  totalEngagement: 450,
  avgEngagement: 150
}
```

### Task with Instagram Post
```javascript
{
  id: "task-123",
  title: "Launch Campaign",
  boardId: "board-456",
  columnId: "col-789",
  instagramPostId: "17882028456123456",
  description: "...",
  dueDate: "2024-04-15T18:00:00",
  // ... other fields
}
```

---

## Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| 400 | Bad Request (invalid account ID) | Verify account ID format |
| 401 | Unauthorized (invalid token) | Re-generate token |
| 403 | Forbidden (insufficient permissions) | Check token permissions |
| 404 | Not Found (post/account deleted) | Verify post still exists |
| 429 | Rate Limit Exceeded | Wait 1 hour before retrying |
| 500 | Server Error | Retry after short delay |

---

## Rate Limiting

**Instagram Graph API Limits**:
- 200 calls per user per hour
- 200 calls per page per hour
- 200 calls per app per hour

**App Strategy**:
- Caches results
- Batches requests
- Respects rate limits
- Shows user-friendly error messages

---

## Security

### Token Handling
- ✅ Stored securely in database
- ✅ Never logged or exposed
- ✅ Only sent to official API endpoints
- ✅ HTTPS required in production

### Data Protection
- ✅ No sensitive data stored
- ✅ User data private
- ✅ No third-party sharing
- ✅ Complies with Instagram ToS

---

## Examples

### Fetch and Display Account Info
```javascript
const token = appData.settings.instagramAccessToken;
const accountId = appData.settings.instagramBusinessAccountId;

const account = await fetchInstagramAccountInfo(accountId, token);
console.log(`Followers: ${account.followers_count}`);
console.log(`Posts: ${account.media_count}`);
```

### Get Best Posting Times
```javascript
const media = await fetchInstagramMedia(accountId, token);
const bestTimes = await analyzeBestPostingTimes(media, token);

bestTimes.forEach((slot, idx) => {
  console.log(`#${idx+1}: ${slot.dayName} ${slot.hour}:00 - ${slot.avgEngagement}% engagement`);
});
```

### Link Post to Task
```javascript
currentEditingTask.instagramPostId = "17882028456123456";
await scheduleAutoSave();
displayInstagramPostMetrics("17882028456123456");
```

---

## Testing

### Test Account Setup
1. Create Instagram Business Account (or convert existing)
2. Link to Meta Business Account
3. Create Meta App with Instagram Graph API
4. Generate access token
5. Note the Business Account ID

### Test Endpoints
```bash
# Test Account Access
curl "https://graph.instagram.com/me?access_token=YOUR_TOKEN"

# Test Media Access
curl "https://graph.instagram.com/me/media?fields=id,caption&access_token=YOUR_TOKEN"

# Test Insights
curl "https://graph.instagram.com/{POST_ID}/insights?metric=engagement&access_token=YOUR_TOKEN"
```

---

**Last Updated**: April 5, 2026  
**API Version**: Instagram Graph API v18.0+  
**Status**: Production Ready
