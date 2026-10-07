/** RSS feed XML fixtures for testing the feed poller */

/** A valid RSS 2.0 feed with 2 items */
export const validRssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://testblog.com</link>
    <description>A test blog feed</description>
    <item>
      <title>First Post</title>
      <link>https://testblog.com/first-post</link>
      <guid>https://testblog.com/first-post</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <description>Summary of the first post</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://testblog.com/second-post</link>
      <guid>https://testblog.com/second-post</guid>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
      <description>Summary of the second post</description>
    </item>
  </channel>
</rss>`;

/** An Atom feed with 1 entry */
export const validAtomFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <link href="https://atomblog.com"/>
  <entry>
    <title>Atom Entry</title>
    <link href="https://atomblog.com/atom-entry"/>
    <id>urn:uuid:atom-entry-1</id>
    <updated>2024-01-15T12:00:00Z</updated>
    <summary>An atom feed entry</summary>
  </entry>
</feed>`;

/** An empty feed with no items */
export const emptyFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
    <link>https://emptyfeed.com</link>
    <description>A feed with no items</description>
  </channel>
</rss>`;

/** A feed with an item that has no link */
export const feedWithNoLinkItem = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Broken Feed</title>
    <link>https://brokenfeed.com</link>
    <item>
      <title>No Link Item</title>
      <guid>no-link-guid</guid>
      <description>This item has no link</description>
    </item>
    <item>
      <title>Has Link Item</title>
      <link>https://brokenfeed.com/has-link</link>
      <guid>has-link-guid</guid>
    </item>
  </channel>
</rss>`;

/** Invalid XML that will fail parsing */
export const invalidXml = `This is not valid XML at all <broken`;

/** HTML page returned as the article content for feed items */
export const articleHtml = `<html>
  <head>
    <title>Test Article Page</title>
    <meta property="og:site_name" content="Test Blog" />
  </head>
  <body>
    <article>
      <h1>Test Article</h1>
      <p>This is the first paragraph of a test article with enough content.</p>
      <p>Here is more content to satisfy the Readability content threshold.</p>
      <p>And a third paragraph to make sure we have enough text for parsing.</p>
      <p>Final paragraph with additional details about the topic at hand.</p>
    </article>
  </body>
</html>`;
