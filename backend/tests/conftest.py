import pytest
from app import app
from backend.extensions import db

@pytest.fixture(autouse=True)
def app_context():
    app.config['TESTING'] = True
    with app.app_context():
        yield
