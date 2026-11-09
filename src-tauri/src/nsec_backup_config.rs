//! Trusted build inputs for the desktop backup service. Unset or empty means
//! disabled: `build.rs` and the runtime's `option_env!` both read the
//! process environment, where a workflow can only clear an input by emptying it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Config {
    pub(crate) service_url: String,
    pub(crate) namespace: String,
}

pub(crate) fn configured(
    service: Option<&str>,
    namespace: Option<&str>,
) -> Result<Option<Config>, String> {
    let service = service.filter(|value| !value.is_empty());
    let namespace = namespace.filter(|value| !value.is_empty());
    let (service, namespace) = match (service, namespace) {
        (None, None) => return Ok(None),
        (Some(service), Some(namespace)) => (service, namespace),
        _ => return Err("Configure both backup service URL and namespace".into()),
    };
    let url = url::Url::parse(service).map_err(|_| "Invalid backup service URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Backup service URL must use HTTPS without credentials, query or fragment".into(),
        );
    }
    if namespace.is_empty() || namespace.len() > 255 || namespace.chars().any(char::is_control) {
        return Err("Invalid backup service namespace".into());
    }
    Ok(Some(Config {
        service_url: url.as_str().trim_end_matches('/').to_owned(),
        namespace: namespace.to_owned(),
    }))
}

/// `BUZZ_NSEC_BACKUP_CONSENT=managed` marks an organization-managed build: every
/// local key is backed up and any saved choice is ignored. Unset or empty keeps
/// explicit consent. Managed consent needs configured backup.
pub(crate) fn managed(consent: Option<&str>, configured: bool) -> Result<bool, String> {
    match consent.filter(|value| !value.is_empty()) {
        None => Ok(false),
        Some("managed") if configured => Ok(true),
        Some("managed") => Err("Managed backup consent needs a backup service".into()),
        Some(_) => Err("Backup consent must be empty or managed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_consent_needs_configured_backup() {
        assert_eq!(managed(None, false), Ok(false));
        assert_eq!(managed(Some(""), true), Ok(false));
        assert_eq!(managed(Some("managed"), true), Ok(true));
        assert!(managed(Some("managed"), false).is_err());
        assert!(managed(Some("true"), true).is_err());
    }

    #[test]
    fn backup_is_disabled_until_both_trusted_inputs_are_valid() {
        assert_eq!(configured(None, None).unwrap(), None);
        assert_eq!(configured(Some(""), Some("")).unwrap(), None);
        assert!(configured(Some(""), Some("buzz")).is_err());
        assert!(configured(Some("https://service.example"), Some("")).is_err());
        assert!(configured(Some("https://service.example"), None).is_err());
        assert!(configured(None, Some("buzz")).is_err());
        for service in [
            "",
            "http://service.example",
            "https://user@service.example",
            "https://service.example?key=value",
            "https://service.example#key",
        ] {
            assert!(configured(Some(service), Some("buzz")).is_err());
        }
        for namespace in ["", "buzz\n", &"a".repeat(256)] {
            assert!(configured(Some("https://service.example"), Some(namespace)).is_err());
        }
        assert_eq!(
            configured(Some("https://service.example/api/goose/"), Some("buzz")).unwrap(),
            Some(Config {
                service_url: "https://service.example/api/goose".into(),
                namespace: "buzz".into()
            })
        );
    }
}
