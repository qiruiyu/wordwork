import hashlib, io, os, tempfile, zipfile

os.environ["WORDWORK_DATA_DIR"] = tempfile.mkdtemp(prefix="wordwork-api-test-")

from fastapi.testclient import TestClient
from app.main import app

CONTENT_TYPES='''<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
def docx(text="原始内容。"):
    b=io.BytesIO();xml=f'''<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w14:paraId="00000001"><w:r><w:t>{text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'''
    with zipfile.ZipFile(b,'w') as z:z.writestr('[Content_Types].xml',CONTENT_TYPES);z.writestr('word/document.xml',xml)
    return b.getvalue()
from support import CURRENT_PASSWORDS, DEMO_PASSWORD, changed_password

def login(c,name):
    current=CURRENT_PASSWORDS.get(name,DEMO_PASSWORD)
    body=c.post('/auth/login',json={'username':name,'password':current}).json()
    token=body['access_token']
    if body['member']['must_change_password']:
        new=changed_password(name)
        changed=c.post('/auth/change-password',headers={'Authorization':f'Bearer {token}'},json={'current_password':current,'new_password':new})
        assert changed.status_code==200,changed.text
        CURRENT_PASSWORDS[name]=new
    return token
def headers(t):return {'Authorization':f'Bearer {t}'}
def upload(raw,name='main.docx'):return {'file':(name,raw,'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}

def test_three_person_review_roundtrip_and_rbac():
    with TestClient(app) as c:
        teacher=login(c,'teacher');student=login(c,'student1')
        p=c.post('/projects',headers=headers(teacher),json={'name':'基金申请'});assert p.status_code==200;pid=p.json()['id']
        assert c.post(f'/projects/{pid}/members',headers=headers(teacher),json={'username':'student1','password':'ignored-password','role':'student'}).status_code==200
        base=docx();d=c.post(f'/projects/{pid}/documents',headers=headers(teacher),files=upload(base));assert d.status_code==200;did=d.json()['id']
        r=c.post(f'/projects/{pid}/rounds',headers=headers(teacher),json={'document_id':did}).json();rid=r['id']
        assert c.post(f'/rounds/{rid}/publish',headers=headers(teacher)).status_code==200
        revised=docx('原始重要内容。');digest=hashlib.sha256(revised).hexdigest()
        sub=c.post(f'/rounds/{rid}/submissions',headers=headers(student),data={'base_version_id':r['base_version_id'],'sha256':digest,'note':'补充重要性'},files=upload(revised,'student.docx'))
        assert sub.status_code==200 and sub.json()['status']=='ready_for_review';sid=sub.json()['id']
        diff=c.get(f'/submissions/{sid}/diff',headers=headers(student)).json();assert diff['hunks'] and diff['hunks'][0]['after']=='重要'
        hid=diff['hunks'][0]['id'];assert c.patch(f'/reviews/{sid}/hunks/{hid}',headers=headers(student),json={'decision':'accepted'}).status_code==403
        assert c.patch(f'/reviews/{sid}/hunks/{hid}',headers=headers(teacher),json={'decision':'accepted'}).status_code==200
        assert c.post(f'/reviews/{sid}/finalize',headers=headers(teacher)).status_code==200
        published=c.post(f'/rounds/{rid}/publish-result',headers=headers(teacher),json={});assert published.status_code==200
        versions=c.get(f'/documents/{did}/versions',headers=headers(student));assert versions.status_code==200 and any(v['current'] for v in versions.json())
        assert c.post(f'/submissions/{sid}/comments',headers=headers(student),json={'body':'已核对'}).status_code==200
        assert c.get(f'/submissions/{sid}/comments',headers=headers(teacher)).json()[0]['body']=='已核对'
        assert c.post('/projects',headers=headers(student),json={'name':'no'}).status_code==403
        assert c.get('/projects',headers=headers(student)).json()[0]['id']==pid
