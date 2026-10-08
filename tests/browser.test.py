"""Offline browser regressions using the real pinned SDK and intercepted Supabase responses.
Usage: python tests/browser.test.py --sdk /path/to/supabase-2.117.3.js
No requests to Supabase or other remote services are allowed by the route handler.
"""
import argparse
import base64
import functools
import hashlib
import json
import os
import threading
import time
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--sdk', required=True)
args, remaining = parser.parse_known_args()
SDK = Path(args.sdk).resolve()
assert base64.b64encode(hashlib.sha384(SDK.read_bytes()).digest()).decode() == 'BWcjm9OdFth9TbhCxZPdm+gAOUMAzQy9nmTs12ioXdCcbVnJaPMn+fMUoQCLt60R', 'SDK does not match the pinned integrity hash'
ROOT = Path(__file__).resolve().parents[1]

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip('=')

class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.playwright.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(ignore_https_errors=False, timezone_id='America/Sao_Paulo')
        self.page = self.context.new_page()
        self.errors = []; self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.rows = {'Receitas': [], 'Despesas': []}
        self.calls = []; self.block_sdk = False; self.bad_sdk = False; self.fail_reads = False
        self.read_queries = []; self.fail_period_read = False; self.read_failure_status = 503
        self.uid = '00000000-0000-4000-8000-000000000001'
        self.write_response_lost = False; self.fail_after_write = False; self.auth_failure = None
        self.context.route('**/*', self.route)

    def tearDown(self):
        self.context.close()

    def route(self, route):
        req = route.request; url = urlparse(req.url)
        if url.hostname == '127.0.0.1' and url.port == self.server.server_port:
            route.continue_(); return
        headers = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}
        if url.hostname == 'cdn.jsdelivr.net':
            if self.block_sdk: route.abort(); return
            if self.bad_sdk: route.fulfill(body='/* deliberately corrupted SDK */', content_type='application/javascript', headers=headers); return
            route.fulfill(path=str(SDK), content_type='application/javascript', headers=headers); return
        if url.hostname != 'jbglqcaeopuznaxmiuss.supabase.co':
            route.abort(); return
        self.calls.append((req.method, url.path))
        if url.path == '/auth/v1/token':
            if self.auth_failure == 'connection': route.abort(); return
            if self.auth_failure:
                status = self.auth_failure
                route.fulfill(status=status, json={'error_code': 'invalid_credentials' if status == 400 else 'unexpected_failure', 'msg': 'synthetic auth error'}, headers=headers); return
            uid = self.uid
            token = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': uid, 'exp': int(time.time()) + 3600, 'role': 'authenticated'}) + '.synthetic'
            body = {'access_token': token, 'refresh_token': 'synthetic-refresh', 'token_type': 'bearer', 'expires_in': 3600, 'user': {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'audit@example.invalid'}}
        elif url.path == '/auth/v1/logout':
            route.fulfill(status=204, headers=headers); return
        elif url.path.startswith('/rest/v1/'):
            table = url.path.rsplit('/', 1)[1]
            if req.method == 'GET':
                filters = parse_qs(url.query)
                self.read_queries.append((table, filters))
                if self.fail_reads or (self.fail_period_read and 'Data' in filters):
                    route.fulfill(status=self.read_failure_status, json={'code': 'PGRST301' if self.read_failure_status == 401 else 'synthetic_outage', 'message': 'synthetic outage'}, headers=headers); return
                body = self.rows[table].copy()
                for bound in filters.get('Data', []):
                    operator, value = bound.split('.', 1)
                    if operator == 'gte': body = [row for row in body if row['Data'][:10] >= value]
                    if operator == 'lt': body = [row for row in body if row['Data'][:10] < value]
            elif req.method in ('POST', 'PATCH'):
                if req.method == 'POST':
                    item = req.post_data_json; item['id'] = len(self.rows[table]) + 1; self.rows[table].append(item)
                else:
                    ident = int(parse_qs(url.query)['id'][0].split('.')[1]); item = next(row for row in self.rows[table] if row['id'] == ident); item.update(req.post_data_json)
                if self.write_response_lost: route.abort(); return
                if self.fail_after_write: self.fail_reads = True
                body = [{'id': item['id']}]
            else:
                # Deletion is intentionally never accepted in browser tests.
                route.abort(); return
        else:
            route.abort(); return
        route.fulfill(status=200, json=body, headers=headers)

    def login(self):
        self.page.goto(self.base)
        self.page.locator('#login').wait_for(state='visible')
        self.page.locator('#email').fill('audit@example.invalid'); self.page.locator('#senha').fill('synthetic-only')
        self.page.locator('#entrar').click()
        if not self.auth_failure:
            self.page.locator('#painel').wait_for(state='visible')
            self.page.wait_for_function("document.getElementById('totalDespesas').textContent.includes('0,00')")

    def save(self, kind='despesa', title='Synthetic expense', amount='12.34', date=None):
        self.page.locator('#tipo' + kind.capitalize()).click()
        self.page.locator('#descricao').fill(title); self.page.locator('#valor').fill(amount)
        if date: self.page.locator('#data').fill(date)
        self.page.locator('#salvar').click()

    def test_income_expense_edit_csv_and_responsive_layout(self):
        self.login(); self.save()
        self.page.wait_for_function("document.getElementById('mensagem').textContent==='Lançamento cadastrado.'")
        self.save('receita', 'Synthetic income', '50.00')
        self.page.wait_for_function("document.getElementById('mensagem').textContent==='Lançamento cadastrado.'")
        self.assertEqual(self.page.locator('#saldo').inner_text(), 'R$\xa037,66')
        self.page.locator('#listaReceitas button').filter(has_text='Editar').click()
        self.page.locator('#valor').fill('60.00'); self.page.locator('#salvar').click()
        self.page.wait_for_function("document.getElementById('mensagem').textContent==='Lançamento atualizado.'")
        self.assertEqual(self.page.locator('#saldo').inner_text(), 'R$\xa047,66')
        with self.page.expect_download() as download: self.page.locator('#exportar').click()
        csv = Path(download.value.path()).read_text(encoding='utf-8-sig')
        self.assertIn('"60,00"', csv); self.assertIn('"12,34"', csv)
        for width in (375, 768, 1280):
            self.page.set_viewport_size({'width': width, 'height': 900})
            self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        self.assertEqual(self.errors, [])

    def test_confirmed_write_failed_read_reload_and_read_only_retry(self):
        self.login(); self.fail_after_write = True; self.save()
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Gravação concluída')")
        self.assertNotIn('Lançamento cadastrado.', self.page.locator('#mensagem').inner_text())
        self.assertEqual(self.page.locator('#descricao').input_value(), '')
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.page.reload(); self.page.locator('#painel').wait_for(state='visible')
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Gravação concluída')")
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.fail_reads = False; self.fail_after_write = False; self.page.locator('#atualizar').click()
        self.page.wait_for_function("!document.getElementById('salvar').disabled")
        self.assertEqual(self.page.locator('#totalDespesas').inner_text(), 'R$\xa012,34')
        self.assertEqual(sum(method == 'POST' and path.startswith('/rest/') for method, path in self.calls), 1)
        self.assertEqual(self.errors, [])

    def test_lost_write_response_requires_read_and_explicit_review(self):
        self.login(); self.write_response_lost = True; self.save()
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Não foi possível confirmar')")
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.assertTrue(self.page.locator('#revisarGravacao').is_disabled())
        self.page.reload(); self.page.locator('#painel').wait_for(state='visible')
        self.page.wait_for_function("!document.getElementById('revisarGravacao').disabled")
        self.assertEqual(self.page.locator('#totalDespesas').inner_text(), 'R$\xa012,34')
        self.page.locator('#revisarGravacao').click()
        self.page.locator('#resultadoConferencia').select_option('completed')
        self.page.locator('#conferenciaGravacao button[value=confirm]').click()
        self.page.wait_for_function("!document.getElementById('salvar').disabled")
        self.assertEqual(self.page.locator('#descricao').input_value(), '')
        self.assertEqual(sum(method == 'POST' and path.startswith('/rest/') for method, path in self.calls), 1)
        self.assertEqual(self.errors, [])

    def seed_private_deletion_dialog(self):
        self.login(); self.save(title='PRIVATE previous user expense')
        self.page.wait_for_function("document.getElementById('mensagem').textContent==='Lançamento cadastrado.'")
        self.rows['Despesas'][0]['categoria'] = 'PRIVATE previous user category'
        self.page.locator('#atualizar').click()
        self.page.wait_for_function("document.getElementById('listaDespesas').textContent.includes('PRIVATE previous user category')")
        self.page.locator('#listaDespesas button').filter(has_text='Editar').click()
        self.page.locator('#listaDespesas button').filter(has_text='Excluir').click()
        self.page.locator('#confirmacao').wait_for(state='visible')

    def assert_private_content_cleared(self):
        self.assertEqual(self.page.evaluate("Array.from(document.querySelectorAll('dialog')).some(dialog=>dialog.open)"), False)
        for selector in ('#textoConfirmacao', '#textoConferencia'):
            self.assertEqual(self.page.locator(selector).inner_text(), '')
        for selector in ('#listaDespesas', '#listaReceitas'):
            self.assertIn(self.page.locator(selector).inner_text(), ('', 'Nenhum lançamento neste mês.'))
        self.assertNotIn('PRIVATE', self.page.locator('body').text_content())
        for selector in ('#descricao', '#valor', '#senha', '#email'):
            self.assertEqual(self.page.locator(selector).input_value(), '')
        self.assertEqual(self.page.locator('#categoria [data-custom-category]').count(), 0)
        self.assertFalse(any(method == 'DELETE' for method, _ in self.calls))
        self.assertEqual(self.errors, [])

    def test_logout_closes_private_deletion_dialog(self):
        self.seed_private_deletion_dialog()
        self.page.evaluate("banco.auth.signOut({scope: 'local'})")
        self.page.locator('#login').wait_for(state='visible')
        self.assert_private_content_cleared()

    def test_expired_session_closes_private_deletion_dialog(self):
        self.seed_private_deletion_dialog()
        self.fail_reads = True; self.read_failure_status = 401
        self.page.evaluate('carregar()')
        self.page.locator('#login').wait_for(state='visible')
        self.assertIn('sessão expirou', self.page.locator('#mensagemLogin').inner_text())
        self.assert_private_content_cleared()

    def test_switch_user_closes_private_deletion_dialog(self):
        self.seed_private_deletion_dialog()
        self.uid = '00000000-0000-4000-8000-000000000002'
        self.rows = {'Receitas': [], 'Despesas': []}
        self.page.evaluate("banco.auth.signInWithPassword({email:'other@example.invalid',password:'synthetic-only'})")
        self.page.wait_for_function("state.userId==='00000000-0000-4000-8000-000000000002'")
        self.assert_private_content_cleared()

    def test_logout_clears_uncertain_operation_review_dialog(self):
        self.login(); self.write_response_lost = True; self.save(title='PRIVATE pending expense')
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Não foi possível confirmar')")
        self.page.locator('#atualizar').click()
        self.page.wait_for_function("!document.getElementById('revisarGravacao').disabled")
        self.page.locator('#revisarGravacao').click()
        self.assertIn('PRIVATE pending expense', self.page.locator('#textoConferencia').inner_text())
        self.page.evaluate("banco.auth.signOut({scope:'local'})")
        self.page.locator('#login').wait_for(state='visible')
        self.assert_private_content_cleared()
        self.assertTrue(self.page.evaluate("Object.keys(sessionStorage).some(key=>key.startsWith('macario.pending-write.v1.'))"))

    def check_uncertain_operation_in_another_period(self, kind):
        self.login(); self.page.locator('#mes').fill('2026-10'); self.page.locator('#mes').dispatch_event('change')
        self.write_response_lost = True
        self.save(kind, 'SYNTHETIC previous year operation', '12.34', '2025-12-31')
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Não foi possível confirmar')")
        operation_id = self.page.evaluate('state.pendingWrite.operationId')
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.page.reload(); self.page.locator('#painel').wait_for(state='visible')
        self.page.wait_for_function("!document.getElementById('revisarGravacao').disabled")
        self.assertEqual(self.page.locator('#mes').input_value(), '2025-12')
        self.assertEqual(self.page.evaluate('state.pendingWrite.operationId'), operation_id)
        table = 'Receitas' if kind == 'receita' else 'Despesas'
        self.assertTrue(any(name == table and query.get('Data') == ['gte.2025-12-01', 'lt.2026-01-01'] for name, query in self.read_queries))
        self.assertIn('SYNTHETIC previous year operation', self.page.locator('#lista' + table).inner_text())
        self.assertEqual(self.page.evaluate('state.pendingWrite.phase'), 'uncertain')
        self.page.locator('#revisarGravacao').click()
        details = self.page.locator('#textoConferencia').inner_text()
        self.assertIn('31/12/2025', details); self.assertIn(operation_id, details)
        self.assertIn('12,34', details); self.assertIn('SYNTHETIC previous year operation', details)
        self.page.locator('#conferenciaGravacao button[value=cancel]').click()
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.page.locator('#mes').fill('2026-10'); self.page.locator('#mes').dispatch_event('change')
        self.assertTrue(self.page.locator('#revisarGravacao').is_disabled())
        self.page.locator('#atualizar').click()
        self.page.wait_for_function("!document.getElementById('revisarGravacao').disabled")
        self.assertEqual(self.page.locator('#mes').input_value(), '2025-12')
        self.page.locator('#revisarGravacao').click()
        self.page.locator('#resultadoConferencia').select_option('completed')
        self.page.locator('#conferenciaGravacao button[value=confirm]').click()
        self.page.wait_for_function("!document.getElementById('salvar').disabled")
        self.assertEqual(sum(method == 'POST' and path.startswith('/rest/') for method, path in self.calls), 1)
        self.assertEqual(len(self.rows[table]), 1)
        self.assertEqual(self.errors, [])

    def test_uncertain_expense_in_another_year_is_reviewed_in_its_period(self):
        self.check_uncertain_operation_in_another_period('despesa')

    def test_uncertain_income_in_another_year_is_reviewed_in_its_period(self):
        self.check_uncertain_operation_in_another_period('receita')

    def test_successful_history_read_does_not_hide_failed_period_read(self):
        self.login(); self.write_response_lost = True
        self.save(title='SYNTHETIC uncertain expense', date='2025-08-15')
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Não foi possível confirmar')")
        self.fail_period_read = True
        self.page.locator('#atualizar').click()
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('temporariamente indisponível')")
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.assertTrue(self.page.locator('#revisarGravacao').is_disabled())
        self.assertEqual(self.page.evaluate('state.pendingWrite.phase'), 'uncertain')
        self.assertEqual(sum(method == 'POST' and path.startswith('/rest/') for method, path in self.calls), 1)

    def test_bigint_large_decimal_balance_and_csv_remain_exact(self):
        self.login()
        self.page.evaluate("""() => {
            const date = document.getElementById('mes').value + '-01';
            state.receitas = [
                {id: 1, Data: date, 'Descrição': 'Synthetic decimal', Valor: '0.10'},
                {id: 2, Data: date, 'Descrição': 'Synthetic large', Valor: '90071992547409.93'}
            ];
            state.despesas = [{id: 3, Data: date, Descricao: 'Synthetic expense', Valor: '0.20', categoria: 'Outros'}];
            renderizar();
        }""")
        self.assertEqual(self.page.locator('#saldo').inner_text(), 'R$\xa090.071.992.547.409,83')
        with self.page.expect_download() as download: self.page.locator('#exportar').click()
        csv = Path(download.value.path()).read_text(encoding='utf-8-sig')
        for value in ('"90071992547409,93"', '"0,10"', '"0,20"'):
            self.assertIn(value, csv)
        self.assertFalse(any(method in ('POST', 'PATCH', 'DELETE') and path.startswith('/rest/') for method, path in self.calls))
        self.assertEqual(self.errors, [])

    def test_an_uncertain_review_result_keeps_writes_blocked(self):
        self.login(); self.write_response_lost = True; self.save()
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('Não foi possível confirmar')")
        self.page.locator('#atualizar').click()
        self.page.wait_for_function("!document.getElementById('revisarGravacao').disabled")
        self.page.locator('#revisarGravacao').click()
        self.page.locator('#conferenciaGravacao button[value=confirm]').click()
        self.assertTrue(self.page.locator('#conferenciaGravacao').is_visible())
        self.page.locator('#resultadoConferencia').select_option('uncertain')
        self.page.locator('#conferenciaGravacao button[value=confirm]').click()
        self.page.wait_for_function("document.getElementById('mensagem').textContent.includes('resultado continua incerto')")
        self.assertEqual(self.page.evaluate('state.pendingWrite.phase'), 'uncertain')
        self.assertTrue(self.page.locator('#salvar').is_disabled())
        self.assertEqual(sum(method == 'POST' and path.startswith('/rest/') for method, path in self.calls), 1)
        self.assertEqual(self.errors, [])

    def test_auth_error_messages(self):
        for failure, expected in ((400, 'E-mail ou senha incorretos.'), (503, 'temporariamente indisponível'), ('connection', 'Verifique sua conexão')):
            self.auth_failure = failure; self.login()
            self.page.wait_for_function("document.getElementById('mensagemLogin').textContent!=='Entrando...'")
            self.assertIn(expected, self.page.locator('#mensagemLogin').inner_text())
            self.assertEqual(self.page.locator('#senha').input_value(), '')
            self.assertFalse(self.page.locator('#entrar').is_disabled())

    def test_signout_event_hides_and_clears_financial_data(self):
        self.login(); self.save()
        self.page.wait_for_function("document.getElementById('mensagem').textContent==='Lançamento cadastrado.'")
        # This SDK call is also fully intercepted, never sent to the real project.
        self.page.evaluate("banco.auth.signOut({scope: 'local'})")
        self.page.locator('#login').wait_for(state='visible')
        self.assertEqual(self.page.locator('#listaDespesas').inner_text(), '')
        self.assertEqual(self.page.locator('#totalDespesas').inner_text(), '—')
        self.assertEqual(self.errors, [])

    def test_blocked_sdk_displays_retry(self):
        self.block_sdk = True; self.page.goto(self.base)
        self.page.locator('#tentarInicializacao').wait_for(state='visible')
        self.assertIn('Não foi possível iniciar', self.page.locator('#mensagemInicializacao').inner_text())
        self.assertEqual(self.errors, [])

    def test_integrity_rejects_corrupted_sdk(self):
        self.bad_sdk = True; self.page.goto(self.base)
        self.page.locator('#tentarInicializacao').wait_for(state='visible')
        self.assertTrue(self.page.locator('#painel').is_hidden())
        self.assertEqual(self.errors, [])

if __name__ == '__main__':
    unittest.main(argv=[__file__] + remaining)
