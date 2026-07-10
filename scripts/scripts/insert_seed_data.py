import psycopg2
import os
import re

DB_URL = os.environ.get('DATABASE_URL', 'postgresql://modelwiki:[REDACTED_PG_PASS]@localhost:5432/modelwiki')

def slugify(text):
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text[:255]

figures = [
    {'name': 'Rem 1/7 Scale Figure (Wedding Ver.)', 'name_jp': 'レム 1/7スケールフィギュア ウェディングVer.', 'name_en': 'Rem 1/7 Scale Figure (Wedding Ver.)', 'scale': '1/7', 'material': 'PVC/ABS', 'price_jpy': 22800, 'release_date': '2025-06-15', 'height_mm': 260, 'manufacturer_slug': 'alter', 'series_slug': 're-zero', 'category_slug': 'scale-figure'},
    {'name': 'Asuna 1/7 Scale Figure (Undine Ver.)', 'name_jp': 'アスナ 1/7スケールフィギュア ウンディーネVer.', 'name_en': 'Asuna 1/7 Scale Figure (Undine Ver.)', 'scale': '1/7', 'material': 'PVC/ABS', 'price_jpy': 25000, 'release_date': '2025-04-20', 'height_mm': 270, 'manufacturer_slug': 'kotobukiya', 'series_slug': 'sword-art-online', 'category_slug': 'scale-figure'},
    {'name': 'Megumin 1/7 Scale Figure', 'name_jp': 'めぐみん 1/7スケールフィギュア', 'name_en': 'Megumin 1/7 Scale Figure', 'scale': '1/7', 'material': 'PVC/ABS', 'price_jpy': 19800, 'release_date': '2025-07-10', 'height_mm': 240, 'manufacturer_slug': 'kadokawa', 'series_slug': 'kono-subarashii', 'category_slug': 'scale-figure'},
    {'name': 'Zero Two 1/7 Scale Figure', 'name_jp': 'ゼロツー 1/7スケールフィギュア', 'name_en': 'Zero Two 1/7 Scale Figure', 'scale': '1/7', 'material': 'PVC/ABS', 'price_jpy': 26800, 'release_date': '2025-09-01', 'height_mm': 275, 'manufacturer_slug': 'alter', 'series_slug': 'darling-in-the-franxx', 'category_slug': 'scale-figure'},
    {'name': 'Miku Hatsune 1/4 Scale Figure (Snow Miku 2025)', 'name_jp': '初音ミク 1/4スケールフィギュア スノーミク2025', 'name_en': 'Miku Hatsune 1/4 Scale Figure (Snow Miku 2025)', 'scale': '1/4', 'material': 'PVC/ABS', 'price_jpy': 38000, 'release_date': '2025-02-14', 'height_mm': 400, 'manufacturer_slug': 'freeing', 'series_slug': 'vocaloid', 'category_slug': 'scale-figure'},
    {'name': 'Nezuko Kamado Nendoroid', 'name_jp': '竈門禰豆子 ねんどろいど', 'name_en': 'Nezuko Kamado Nendoroid', 'scale': None, 'material': 'PVC/ABS', 'price_jpy': 5500, 'release_date': '2025-05-20', 'height_mm': 100, 'manufacturer_slug': 'good-smile-company', 'series_slug': 'demon-slayer', 'category_slug': 'nendoroid'},
    {'name': 'Gojo Satoru figma', 'name_jp': '五条悟 figma', 'name_en': 'Gojo Satoru figma', 'scale': None, 'material': 'PVC/ABS', 'price_jpy': 9800, 'release_date': '2025-08-15', 'height_mm': 155, 'manufacturer_slug': 'max-factory', 'series_slug': 'jujutsu-kaisen', 'category_slug': 'figma'},
    {'name': 'Anya Forger Prize Figure', 'name_jp': 'アーニャ・フォージャー プライズフィギュア', 'name_en': 'Anya Forger Prize Figure', 'scale': None, 'material': 'PVC', 'price_jpy': 3500, 'release_date': '2025-03-01', 'height_mm': 140, 'manufacturer_slug': 'taito', 'series_slug': 'spy-x-family', 'category_slug': 'prize-figure'},
    {'name': 'Emilia 1/7 Scale Figure (Ice Season Ver.)', 'name_jp': 'エミリア 1/7スケールフィギュア アイスシーズンVer.', 'name_en': 'Emilia 1/7 Scale Figure (Ice Season Ver.)', 'scale': '1/7', 'material': 'PVC/ABS', 'price_jpy': 23500, 'release_date': '2025-11-20', 'height_mm': 265, 'manufacturer_slug': 'alter', 'series_slug': 're-zero', 'category_slug': 'scale-figure'},
    {'name': 'Goku Ultra Instinct 1/6 Scale Figure', 'name_jp': '孫悟空 身勝手の極意 1/6スケールフィギュア', 'name_en': 'Goku Ultra Instinct 1/6 Scale Figure', 'scale': '1/6', 'material': 'PVC/ABS/Resin', 'price_jpy': 45000, 'release_date': '2025-12-01', 'height_mm': 350, 'manufacturer_slug': 'banpresto', 'series_slug': 'dragon-ball', 'category_slug': 'scale-figure'},
]

conn = psycopg2.connect(DB_URL)
cur = conn.cursor()

success = 0
skipped = 0
for fig in figures:
    slug = slugify(fig['name_en'])
    cur.execute('SELECT id FROM figures WHERE slug = %s', (slug,))
    if cur.fetchone():
        print('  Skip (exists): ' + fig['name_en'])
        skipped += 1
        continue

    mfr_id = None
    if fig.get('manufacturer_slug'):
        cur.execute('SELECT id FROM manufacturers WHERE slug = %s', (fig['manufacturer_slug'],))
        row = cur.fetchone()
        if row:
            mfr_id = row[0]
        else:
            mfr_name = fig['manufacturer_slug'].replace('-', ' ').title()
            cur.execute('INSERT INTO manufacturers (slug, name, name_en) VALUES (%s, %s, %s) RETURNING id',
                        (fig['manufacturer_slug'], mfr_name, mfr_name))
            mfr_id = cur.fetchone()[0]

    series_id = None
    if fig.get('series_slug'):
        cur.execute('SELECT id FROM series WHERE slug = %s', (fig['series_slug'],))
        row = cur.fetchone()
        if row:
            series_id = row[0]
        else:
            series_name = fig['series_slug'].replace('-', ' ').title()
            cur.execute('INSERT INTO series (slug, name, name_en) VALUES (%s, %s, %s) RETURNING id',
                        (fig['series_slug'], series_name, series_name))
            series_id = cur.fetchone()[0]

    cat_id = 5
    if fig.get('category_slug'):
        cur.execute('SELECT id FROM categories WHERE slug = %s', (fig['category_slug'],))
        row = cur.fetchone()
        if row:
            cat_id = row[0]

    cur.execute(
        '''INSERT INTO figures (slug, name, name_jp, name_en, scale, material, price_jpy, release_date, height_mm, series_id, manufacturer_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id''',
        (slug, fig['name'], fig.get('name_jp'), fig.get('name_en'), fig.get('scale'), fig.get('material'),
         fig.get('price_jpy'), fig.get('release_date'), fig.get('height_mm'), series_id, mfr_id)
    )
    fig_id = cur.fetchone()[0]

    cur.execute('INSERT INTO figure_category (figure_id, category_id) VALUES (%s, %s)', (fig_id, cat_id))

    conn.commit()
    success += 1
    print('  + Inserted: ' + fig['name_en'] + ' (ID: ' + str(fig_id) + ')')

cur.close()
conn.close()
print('\nDone! Inserted: ' + str(success) + ', Skipped: ' + str(skipped))
