# Instagram Analytics Dashboard - Code Locations & Integration Points

## Quick Reference: Where Everything Is

### Main HTML Container
- **Location**: Line 1764
- **Element ID**: `#analytics-content`
- **Container Class**: `analytics-wrapper`
```html
<div class="analytics-wrapper" id="analytics-content"></div>
```

### Navigation Tab
- **Location**: Line 1749
- **Button ID**: `tab-analytics`
- **Icon**: 📊
- **Onclick**: `switchView('analytics')`
```html
<button class="nav-tab" id="tab-analytics" onclick="switchView('analytics')" style="display:none;">📊 Analytics</button>
```

---

## JavaScript Functions Location

All functions are in `<script>` tags at the end of the file, starting at **line 9245**.

### Core Analytics Functions
| Function | Line | Purpose |
|----------|------|---------|
| `renderAnalytics()` | 9257 | Main dashboard renderer |
| `loadAnalyticsData(token)` | 9275 | Fetch all analytics data |
| `fetchInstagramAccountInfo()` | 9310 | Get account info from API |
| `fetchInstagramMedia()` | 9330 | Get recent posts from API |
| `analyzeBestPostingTimes()` | 9350 | Analyze 60-day posting patterns |
| `renderAnalyticsDashboard()` | 9385 | Render all dashboard sections |

### Display Functions
| Function | Line | Purpose |
|----------|------|---------|
| `renderPostsGrid()` | 9430 | Render 12 posts grid |
| `renderBestTimesTable()` | 9485 | Render time analysis table |
| `formatNumber()` | 9530 | Format large numbers (K, M) |
| `calculateFollowerGrowth()` | 9520 | Calculate growth metrics |
| `calculateAverageEngagement()` | 9530 | Average engagement rate |
| `calculatePostEngagement()` | 9540 | Per-post engagement % |

### Task Integration Functions
| Function | Line | Purpose |
|----------|------|---------|
| `linkInstagramPost()` | 9596 | Link post to task |
| `displayInstagramPostMetrics()` | 9613 | Show post metrics |
| `openInstagramPostPicker()` | 9673 | Open post selector modal |
| `selectInstagramPost()` | 9738 | Handle post selection |
| `renderTaskPostMetrics()` | 9660 | Display metrics on task |

### Utility Functions
| Function | Line | Purpose |
|----------|------|---------|
| `updateAnalyticsTabVisibility()` | 9248 | Show/hide analytics tab |
| `refreshAnalytics()` | 9578 | Manual data refresh |
| `getMetricValue()` | 9550 | Extract metric from insights |

---

## Task Modal Integration Points

### Instagram Post Link Section
- **Location**: Lines 2190-2203
- **Contains**:
  - Post ID input field: `#taskInstagramPostId`
  - Link button: onclick=`linkInstagramPost()`
  - Metrics display: `#instagramPostMetrics`

### Post Picker Button
- **Location**: Line 2270
- **Button ID**: `instagramPostLinkBtn`
- **Onclick**: `openInstagramPostPicker()`
- **Class**: `sidebar-btn`

---

## Settings Integration Points

### Instagram Token Settings
- **Location**: Lines 2019-2033
- **Token Input ID**: `#instagramAccessToken`
- **Account ID Input ID**: `#instagramBusinessAccountId`
- **Verify Button**: onclick=`verifyInstagramToken()`
- **Status Message ID**: `#instagramStatusMessage`

### Configuration Save
- **Function**: `saveInstagramSettings()`
- **Updates**: 
  - `appData.settings.instagramAccessToken`
  - `appData.settings.instagramBusinessAccountId`

---

## CSS Classes Location

All analytics CSS is defined in `<style>` tags (lines 29-1615).

### Analytics Wrapper Styles
- **Location**: Lines 1187-1615
- **Classes Defined**:

| Class | Lines | Purpose |
|-------|-------|---------|
| `.analytics-wrapper` | 1187-1197 | Main container |
| `.analytics-header` | 1199-1212 | Header section |
| `.analytics-grid` | 1235-1239 | Stats cards grid |
| `.stat-card` | 1241-1255 | Individual stat card |
| `.post-card` | 1317-1331 | Post grid card |
| `.post-thumbnail` | 1333-1344 | Post image container |
| `.best-time-table` | 1399-1421 | Time analysis table |
| `.analytics-empty` | 1448-1459 | Empty state |
| `.loading-spinner` | 1434-1446 | Loading animation |

### Responsive Styles
- **Location**: Lines 1587-1614
- **Breakpoint**: max-width: 768px (tablet/mobile)

---

## Data Flow Integration

### Where Instagram Settings Are Used

1. **Settings Component** (Line 1806)
   - User enters token and account ID
   - Stored in `appData.settings`

2. **Analytics Tab Check** (Line 9248)
   - Function: `updateAnalyticsTabVisibility()`
   - Checks if `appData.settings.instagramAccessToken` exists
   - Shows/hides tab accordingly

3. **Analytics Loading** (Line 9275)
   - Gets token from `appData.settings.instagramAccessToken`
   - Gets account ID from `appData.settings.instagramBusinessAccountId`
   - Passes to API functions

4. **Task Linking** (Line 9596)
   - Gets token for API calls
   - Stores `instagramPostId` on task
   - Saved with task data

---

## switchView() Integration

**Location**: Lines 3268-3289

```javascript
function switchView(viewName) {
    // ... existing code ...
    if (viewName === 'analytics') renderAnalytics();  // Line 3288
}
```

When user clicks 📊 Analytics tab:
1. `switchView('analytics')` is called
2. Analytics view element becomes active
3. `renderAnalytics()` is invoked
4. Dashboard loads and displays

---

## Modal Integration

### Instagram Post Picker Modal
- **Creation**: Line 9681 (creates if doesn't exist)
- **Modal ID**: `instagramPostPickerModal`
- **Triggered By**: `openInstagramPostPicker()` (line 9673)
- **Closes On**: User selection or close button

### Task Modal
- **ID**: `#taskModal`
- **Instagram Section**: Lines 2190-2203
- **Picker Button**: Line 2270
- **Metrics Display**: Line 2198

---

## API Call Locations

### Account Info API
- **Function**: `fetchInstagramAccountInfo()` (line 9310)
- **Endpoint**: `GET /me`
- **Called From**: `loadAnalyticsData()` (line 9297)

### Media API
- **Function**: `fetchInstagramMedia()` (line 9330)
- **Endpoint**: `GET /me/media`
- **Called From**: `loadAnalyticsData()` (line 9298)

### Post Insights API
- **Function**: `displayInstagramPostMetrics()` (line 9613)
- **Endpoint**: `GET /{mediaId}/insights`
- **Called From**: `linkInstagramPost()` (line 9607)

---

## Storage & Persistence

### Where Instagram Data is Stored
```javascript
appData.settings = {
  instagramAccessToken: "...",           // Line 5284
  instagramBusinessAccountId: "...",     // Line 5285
  instagramFollowerHistory: [...],       // Optional
  initialFollowerCount: 0                // Optional
}
```

### Where Task Links are Stored
```javascript
currentEditingTask = {
  id: "task-123",
  instagramPostId: "17882028456123456",  // Added by linkInstagramPost()
  // ... other task fields
}
```

### Data Persistence
- **Save Function**: `saveData()` (after any change)
- **Storage Method**: Supabase (`_supabase.from('app_state').upsert()`)
- **Load Function**: Called on app init (line 2685+)

---

## Key Variables

### Global Scope
- `currentEditingTask` (Line 6552) - Current task being edited
- `appData` (Line 2586) - All app data
- `isAuthenticated` (Line 2590+) - Auth state

### Settings
- `appData.settings.instagramAccessToken` - API token
- `appData.settings.instagramBusinessAccountId` - Account ID

### Task
- `currentEditingTask.instagramPostId` - Linked post ID

---

## Event Listeners & Onclick Handlers

| Element | Event | Handler | Location |
|---------|-------|---------|----------|
| Analytics Tab | click | `switchView('analytics')` | Line 1749 |
| Verify Token Btn | click | `verifyInstagramToken()` | Line 2029 |
| Refresh Btn | click | `refreshAnalytics()` | Line 9278 |
| Link Post Btn | click | `linkInstagramPost()` | Line 2196 |
| Link IG Post | click | `openInstagramPostPicker()` | Line 2270 |
| Post Picker Post | click | `selectInstagramPost()` | Line 9711 |

---

## Important Line Numbers Reference

| Item | Line | Description |
|------|------|-------------|
| HTML Container | 1764 | `#analytics-content` |
| Analytics Tab | 1749 | `#tab-analytics` |
| Settings Integrations | 1806 | Config section |
| Instagram Token Input | 2019 | `#instagramAccessToken` |
| Post Link Section | 2190 | Task modal |
| Post Picker Btn | 2270 | `#instagramPostLinkBtn` |
| CSS Styles Start | 29 | Style tag open |
| Analytics CSS | 1187 | Analytics styles |
| Script Start | 2515 | JavaScript section |
| Functions Start | 9245 | Analytics functions |
| switchView Update | 3288 | Analytics integration |

---

## How to Modify

### Add a New Metric
1. Add metric field to `fetchInstagramMedia()` line 9332
2. Extract in `getMetricValue()` line 9550
3. Display in `renderPostsGrid()` line 9430

### Change Best Times Analysis
1. Modify `analyzeBestPostingTimes()` line 9350
2. Change `sixtyDaysAgo` calculation (line 9352)
3. Adjust table display in `renderBestTimesTable()` line 9470

### Update Error Messages
1. Modify try-catch blocks in `loadAnalyticsData()` line 9275
2. Update `renderAnalytics()` error display (line 9265)

### Style Changes
1. Modify CSS classes (lines 1187-1615)
2. Update mobile breakpoint (line 1587)

---

## Testing Checklist

- [ ] Analytics tab shows when token present
- [ ] Analytics tab hidden when no token
- [ ] Dashboard loads and displays data
- [ ] Recent posts grid shows 12 posts
- [ ] Best times table calculates correctly
- [ ] Post picker modal works
- [ ] Linking post to task works
- [ ] Metrics display on linked posts
- [ ] Refresh button updates data
- [ ] Mobile responsive design works
- [ ] Error handling shows messages
- [ ] Loading spinners appear
- [ ] Data persists after reload

---

**Last Updated**: April 5, 2026  
**Total Code Locations**: 50+  
**Integration Points**: 15+  
**CSS Classes**: 12+  
**JavaScript Functions**: 14+
