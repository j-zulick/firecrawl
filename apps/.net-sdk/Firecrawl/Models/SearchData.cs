using System.Text.Json.Serialization;

namespace Firecrawl.Models;

/// <summary>
/// Represents a single search hit with URL, title, and snippet.
/// </summary>
public class SearchHit
{
    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("description")]
    public string? Description { get; set; }

    [JsonPropertyName("markdown")]
    public string? Markdown { get; set; }

    [JsonPropertyName("html")]
    public string? Html { get; set; }

    [JsonPropertyName("rawHtml")]
    public string? RawHtml { get; set; }

    [JsonPropertyName("metadata")]
    public Dictionary<string, object>? Metadata { get; set; }

    [JsonPropertyName("links")]
    public List<string>? Links { get; set; }

    [JsonPropertyName("screenshot")]
    public string? Screenshot { get; set; }
}

/// <summary>
/// Web search results.
/// </summary>
public class SearchData
{
    [JsonPropertyName("web")]
    public List<SearchHit>? Web { get; set; }

    [JsonPropertyName("news")]
    public List<SearchHit>? News { get; set; }

    [JsonPropertyName("images")]
    public List<string>? Images { get; set; }
}
