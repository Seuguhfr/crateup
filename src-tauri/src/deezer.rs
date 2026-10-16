use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ArlStatusResult {
    pub valid: bool,
    pub status: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_lossless: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ResolvedDeezerTrack {
    pub original_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn extract_track_id(text: &str) -> Option<i64> {
    let clean = text.trim();
    if clean.is_empty() {
        return None;
    }

    // Direct numeric string
    if clean.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(id) = clean.parse::<i64>() {
            if id > 0 {
                return Some(id);
            }
        }
    }

    // Try URL decoding if percent-encoded
    let decoded = percent_encoding::percent_decode_str(clean)
        .decode_utf8_lossy()
        .to_string();

    // Match track/12345 or track:12345
    for token in ["track/", "track:", "track%2F"] {
        if let Some(idx) = decoded.find(token) {
            let rest = &decoded[idx + token.len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(id) = digits.parse::<i64>() {
                if id > 0 {
                    return Some(id);
                }
            }
        }
    }

    // Match trailing numeric ID: e.g. deezer.com/fr/track/2415350 or deezer.com/.../2415350
    if decoded.contains("deezer.com") {
        let parts: Vec<&str> = decoded.split(&['/', '?', '#'][..]).collect();
        for part in parts.iter().rev() {
            if !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(id) = part.parse::<i64>() {
                    if id > 0 {
                        return Some(id);
                    }
                }
            }
        }
    }

    None
}

pub async fn validate_arl(arl: &str) -> Result<ArlStatusResult, String> {
    let clean_arl = arl.trim();
    if clean_arl.is_empty() {
        return Ok(ArlStatusResult {
            valid: false,
            status: "missing".to_string(),
            message: "No Deezer ARL token provided.".to_string(),
            user_id: None,
            user_name: None,
            is_lossless: None,
        });
    }

    let url = "https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=null&input=3";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let res = client
        .get(url)
        .header("Cookie", format!("arl={}", clean_arl))
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Accept", "application/json, text/plain, */*")
        .send()
        .await;

    let response = match res {
        Ok(r) => r,
        Err(e) => {
            let status = if e.is_timeout() { "timeout" } else { "network_error" };
            return Ok(ArlStatusResult {
                valid: false,
                status: status.to_string(),
                message: format!("Network error connecting to Deezer: {}", e),
                user_id: None,
                user_name: None,
                is_lossless: None,
            });
        }
    };

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Deezer response: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!("Could not parse Deezer response: {}", e)
    })?;

    let user = data.get("results").and_then(|r| r.get("USER"));
    let user_id = user
        .and_then(|u| u.get("USER_ID"))
        .and_then(|v| {
            if let Some(n) = v.as_u64() {
                Some(n)
            } else if let Some(s) = v.as_str() {
                s.parse::<u64>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    let user_name = user
        .and_then(|u| u.get("BLOG_NAME").or_else(|| u.get("USER_NAME")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let is_lossless = user
        .and_then(|u| u.get("OPTIONS"))
        .map(|opt| {
            opt.get("lossless").and_then(|v| v.as_bool()).unwrap_or(false)
                || opt.get("web_lossless").and_then(|v| v.as_bool()).unwrap_or(false)
                || opt
                    .get("mobile_sound_quality")
                    .and_then(|m| m.get("lossless"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
        })
        .unwrap_or(false);

    if user_id > 0 {
        let name_display = user_name.clone().unwrap_or_else(|| "Deezer User".to_string());
        let tier_display = if is_lossless {
            " · Hi-Fi Lossless"
        } else {
            " · Standard"
        };
        Ok(ArlStatusResult {
            valid: true,
            status: "valid".to_string(),
            message: format!("Connected as {} (ID: {}){}", name_display, user_id, tier_display),
            user_id: Some(user_id),
            user_name,
            is_lossless: Some(is_lossless),
        })
    } else {
        Ok(ArlStatusResult {
            valid: false,
            status: "expired".to_string(),
            message: "Deezer ARL token is invalid or expired. Please refresh your ARL cookie.".to_string(),
            user_id: None,
            user_name: None,
            is_lossless: None,
        })
    }
}

pub async fn fetch_deezer_metadata(deezer_id: i64) -> Result<(Option<String>, Option<String>, Option<f64>), String> {
    let url = format!("https://api.deezer.com/track/{}", deezer_id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if data.get("error").is_some() {
        return Err(format!("Deezer API error for track {}", deezer_id));
    }

    let artist = data
        .get("artist")
        .and_then(|a| a.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let title = data
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let duration = data
        .get("duration")
        .and_then(|v| v.as_f64());

    Ok((artist, title, duration))
}

pub async fn resolve_deezer_link(url: &str, max_hops: usize) -> Result<ResolvedDeezerTrack, String> {
    let clean_url = url.trim();
    if clean_url.is_empty() {
        return Ok(ResolvedDeezerTrack {
            original_url: url.to_string(),
            resolved_url: None,
            track_id: None,
            artist: None,
            title: None,
            error: Some("Empty URL".to_string()),
        });
    }

    // 1. Direct ID match
    if let Some(id) = extract_track_id(clean_url) {
        let (artist, title, _) = fetch_deezer_metadata(id).await.unwrap_or((None, None, None));
        return Ok(ResolvedDeezerTrack {
            original_url: clean_url.to_string(),
            resolved_url: Some(clean_url.to_string()),
            track_id: Some(id),
            artist,
            title,
            error: None,
        });
    }

    // 2. Follow redirects
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(7))
        .build()
        .map_err(|e| e.to_string())?;

    let mut current_url = clean_url.to_string();
    let mut hops = 0;

    while hops < max_hops {
        hops += 1;
        let res = match client
            .get(&current_url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let fallback = extract_track_id(&current_url);
                return Ok(ResolvedDeezerTrack {
                    original_url: clean_url.to_string(),
                    resolved_url: Some(current_url),
                    track_id: fallback,
                    artist: None,
                    title: None,
                    error: Some(format!("HTTP error during redirect: {}", e)),
                });
            }
        };

        if res.status().is_redirection() {
            if let Some(loc) = res.headers().get("location").and_then(|h| h.to_str().ok()) {
                if let Some(id) = extract_track_id(loc) {
                    let (artist, title, _) = fetch_deezer_metadata(id).await.unwrap_or((None, None, None));
                    return Ok(ResolvedDeezerTrack {
                        original_url: clean_url.to_string(),
                        resolved_url: Some(loc.to_string()),
                        track_id: Some(id),
                        artist,
                        title,
                        error: None,
                    });
                }
                current_url = loc.to_string();
                continue;
            }
        }

        if let Some(id) = extract_track_id(&current_url) {
            let (artist, title, _) = fetch_deezer_metadata(id).await.unwrap_or((None, None, None));
            return Ok(ResolvedDeezerTrack {
                original_url: clean_url.to_string(),
                resolved_url: Some(current_url),
                track_id: Some(id),
                artist,
                title,
                error: None,
            });
        }
        break;
    }

    let fallback_id = extract_track_id(&current_url);
    let (artist, title) = if let Some(id) = fallback_id {
        let (a, t, _) = fetch_deezer_metadata(id).await.unwrap_or((None, None, None));
        (a, t)
    } else {
        (None, None)
    };

    Ok(ResolvedDeezerTrack {
        original_url: clean_url.to_string(),
        resolved_url: Some(current_url),
        track_id: fallback_id,
        artist,
        title,
        error: if fallback_id.is_some() {
            None
        } else {
            Some("No Deezer track ID found in resolved destination".to_string())
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_track_id() {
        assert_eq!(extract_track_id("1234567"), Some(1234567));
        assert_eq!(
            extract_track_id("https://www.deezer.com/track/882920"),
            Some(882920)
        );
        assert_eq!(
            extract_track_id("https://www.deezer.com/fr/track/2415350?utm_source=deezer"),
            Some(2415350)
        );
        assert_eq!(extract_track_id("track:998877"), Some(998877));
        assert_eq!(extract_track_id("https://example.com/not-a-track"), None);
        assert_eq!(extract_track_id(""), None);
    }

    #[tokio::test]
    async fn test_validate_arl_empty() {
        let res = validate_arl("").await.unwrap();
        assert!(!res.valid);
        assert_eq!(res.status, "missing");
    }
}
