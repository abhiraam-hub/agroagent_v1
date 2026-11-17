translations = {
    'en': {
        'welcome': 'Welcome to AgroAgent',
        'dashboard': 'Dashboard',
    },
    'hi': {
        'welcome': 'AgroAgent me svagat hai',
        'dashboard': 'Dashboard',
    }
}

def get_translation(lang, key):
    return translations.get(lang, {}).get(key, translations['en'].get(key, key))

